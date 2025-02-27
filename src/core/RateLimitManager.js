const { EventEmitter } = require('events');
const { emitter, EVENTS } = require('./events');

class RateLimitManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            ...config,
            safetyMargin: config.safetyMargin || 0.9  // Default safety margin if not provided
        };
        this.state = {
            windows: new Map(),
            queue: [],
            isProcessing: false,
            batchState: {
                lastBatchTime: 0,
                retryCount: new Map()
            }
        };

        // Set higher max listeners limit
        this.setMaxListeners(50);

        // Initialize event handling
        this.setupEventHandlers();
    }

    setupEventHandlers() {
        emitter.on(EVENTS.RATE_LIMIT_EXCEEDED, ({ endpoint }) => {
            this.emit('debug', `Rate limit exceeded for ${endpoint}, waiting for reset...`);
            this.resetWindow(endpoint);
        });
    }

    getEndpointLimits(endpoint) {
        return this.config.endpoints?.[endpoint] || this.config.defaultLimit;
    }

    getOrCreateWindow(endpoint) {
        if (!this.state.windows.has(endpoint)) {
            this.state.windows.set(endpoint, {
                startTime: Date.now(),
                requestCount: 0
            });
        }
        return this.state.windows.get(endpoint);
    }

    resetWindow(endpoint) {
        this.state.windows.set(endpoint, {
            startTime: Date.now(),
            requestCount: 0
        });
        this.emit('debug', `Rate limit window reset for ${endpoint}`);
        emitter.emit(EVENTS.RATE_LIMIT_RESET, { endpoint });
    }

    async scheduleRequest(requestFn, endpoint = 'default') {
        try {
            const limits = this.getEndpointLimits(endpoint);
            let window = this.getOrCreateWindow(endpoint);

            // Check if this is a batch request
            const isBatchEndpoint = endpoint === 'tweets/search/recent';
            if (isBatchEndpoint) {
                return await this.handleBatchRequest(requestFn, limits, window);
            }

            // Standard request handling
            const now = Date.now();
            const windowSize = limits.windowSizeMinutes * 60 * 1000;
            if (now - window.startTime >= windowSize) {
                this.resetWindow(endpoint);
                window = this.getOrCreateWindow(endpoint);
            }

            // Check if we're within rate limits
            const safeLimit = Math.floor(limits.requestsPerWindow * this.config.safetyMargin);
            if (window.requestCount >= safeLimit) {
                const waitTime = windowSize - (now - window.startTime);
                this.emit('debug', `Rate limit approaching for ${endpoint}, waiting ${waitTime}ms`);
                emitter.emit(EVENTS.RATE_LIMIT_WARNING, { waitTime, endpoint });
                await new Promise(resolve => setTimeout(resolve, waitTime));
                this.resetWindow(endpoint);
                window = this.getOrCreateWindow(endpoint);
            }

            // Execute the request
            window.requestCount++;
            this.emit('debug', `Executing request for ${endpoint} (${window.requestCount}/${safeLimit})`);
            emitter.emit(EVENTS.REQUEST_SCHEDULED, { endpoint });
            
            const result = await requestFn();
            this.emit('debug', `Request completed for ${endpoint}`);
            emitter.emit(EVENTS.REQUEST_COMPLETED, { endpoint });
            return result;
        } catch (error) {
            this.handleRequestError(error, endpoint);
            throw error;
        }
    }

    async handleBatchRequest(requestFn, limits, window, endpoint = 'tweets/search/recent', requestId = Date.now().toString()) {
        try {
            const now = Date.now();
            const { minIntervalMs } = this.config.batchConfig;
            
            // Enforce minimum interval between batches
            const timeSinceLastBatch = now - this.state.batchState.lastBatchTime;
            if (timeSinceLastBatch < minIntervalMs) {
                const waitTime = minIntervalMs - timeSinceLastBatch;
                this.emit('debug', `Enforcing batch interval, waiting ${waitTime}ms`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }

            // Check and reset window if needed
            const windowSize = limits.windowSizeMinutes * 60 * 1000;
            if (now - window.startTime >= windowSize) {
                this.resetWindow(endpoint);
                window = this.getOrCreateWindow(endpoint);
            }

            // Check rate limits with aggressive safety margin
            const safeLimit = Math.floor(limits.requestsPerWindow * this.config.safetyMargin);
            if (window.requestCount >= safeLimit) {
                const waitTime = windowSize - (now - window.startTime);
                this.emit('debug', `Batch rate limit approaching, waiting ${waitTime}ms`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                this.resetWindow(endpoint);
                window = this.getOrCreateWindow(endpoint);
            }

            // Execute batch request
            window.requestCount++;
            this.state.batchState.lastBatchTime = Date.now();
            this.emit('debug', `Executing batch request ${requestId} for ${endpoint} (${window.requestCount}/${safeLimit})`);
            emitter.emit(EVENTS.REQUEST_SCHEDULED, { endpoint });
            
            const result = await requestFn();
            
            this.emit('debug', `Batch request ${requestId} completed for ${endpoint}`);
            emitter.emit(EVENTS.REQUEST_COMPLETED, { endpoint });
            return result;

        } catch (error) {
            const retryCount = this.state.batchState.retryCount.get(requestId) || 0;
            
            if (error.code === 'RATE_LIMIT' && retryCount < this.config.batchConfig.maxRetries) {
                this.state.batchState.retryCount.set(requestId, retryCount + 1);
                this.emit('debug', `Retrying batch request ${requestId} (attempt ${retryCount + 1}/${this.config.batchConfig.maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, this.config.batchConfig.retryDelayMs));
                return this.handleBatchRequest(requestFn, limits, this.getOrCreateWindow(endpoint), endpoint, requestId);
            } else {
                // Clean up retry counter
                this.state.batchState.retryCount.delete(requestId);
                this.handleRequestError(error, endpoint);
                throw error;
            }
        }
    }

    handleRequestError(error, endpoint) {
        this.emit('debug', `Request failed for ${endpoint}: ${error.message}`);
        
        const isRateLimit = 
            error.code === 429 ||                                  // Standard HTTP rate limit
            error.status === 429 ||                               // Alternative status field
            error.response?.status === 429 ||                     // Axios error structure
            (error.data?.errors?.some(e => e.code === 88)) ||     // Twitter specific
            error.message?.toLowerCase().includes('rate limit') || // Generic message check
            error.response?.data?.message?.toLowerCase().includes('rate limit');

        if (isRateLimit) {
            this.emit('debug', `Rate limit hit for ${endpoint}, resetting window`);
            emitter.emit(EVENTS.RATE_LIMIT_EXCEEDED, { endpoint });
            this.resetWindow(endpoint);
            
            const rateError = new Error('API rate limit exceeded');
            rateError.code = 'RATE_LIMIT';
            rateError.endpoint = endpoint;
            rateError.resetTime = error.rateLimit?.reset || 
                                error.response?.headers?.['x-ratelimit-reset'] ||
                                (Date.now() + 60000); // Default 1 minute
            throw rateError;
        } else {
            this.emit('debug', `Non-rate-limit error for ${endpoint}: ${error.message}`);
            emitter.emit(EVENTS.REQUEST_FAILED, { error, endpoint });
            throw error;
        }
    }
}

module.exports = RateLimitManager; 