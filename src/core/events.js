const { EventEmitter } = require('events');

const EVENTS = {
    RATE_LIMIT_EXCEEDED: 'rateLimitExceeded',
    RATE_LIMIT_WARNING: 'rateLimitWarning',
    RATE_LIMIT_RESET: 'rateLimitReset',
    REQUEST_SCHEDULED: 'requestScheduled',
    REQUEST_COMPLETED: 'requestCompleted',
    REQUEST_FAILED: 'requestFailed'
};

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

module.exports = {
    emitter,
    EVENTS
}; 