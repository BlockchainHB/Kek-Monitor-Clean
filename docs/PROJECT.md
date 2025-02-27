# Twitter Monitor Discord Bot - Technical Documentation

## Project Overview
A Discord bot that monitors Twitter accounts for Solana-related content and tracks Solana wallet transactions, providing real-time notifications and market data analysis.

## 1. Project Structure
```
src/
├── core/                   # Core services and business logic
│   ├── TwitterMonitorBot.js    # Main bot implementation
│   ├── BirdeyeService.js       # Token price and market data
│   ├── HeliusService.js        # Blockchain monitoring
│   ├── RateLimitManager.js     # API rate limit handling
│   └── events.js               # Event system
├── database/               # Database migrations (future)
├── commands/              # Discord command handlers
├── config/               
│   ├── config.js          # Configuration management
│   └── wallets.json       # Wallet tracking config
├── utils/
│   └── check_limits.js    # Rate limit testing
└── index.js               # Application entry point
```

## 2. Architecture Patterns

### Core Design Principles
- **Event-Driven Architecture**: Uses Node.js EventEmitter
- **Dependency Injection**: Services receive dependencies via constructors
- **Rate Limiting**: Centralized management for all API calls
- **In-Memory State**: Uses Map objects for current implementation
- **Service-Oriented**: Modular services with clear responsibilities

### Component Structure
```javascript
class ComponentName {
    constructor(dependencies) {
        this.validateDependencies(dependencies);
        this.rateLimitManager = dependencies.rateLimitManager;
        this.state = this.initializeState();
    }

    validateDependencies(deps) {
        if (!deps.rateLimitManager) throw new Error('RateLimitManager required');
    }
}
```

## 3. Core Components

### TwitterMonitorBot
- Main orchestrator for Discord interactions
- Handles Twitter monitoring and content analysis
- Manages command routing and responses
- Coordinates notifications across channels

### BirdeyeService
- Token price and market data retrieval
- Market statistics analysis
- Token security checks
- Holder analytics

### HeliusService
- Blockchain transaction monitoring
- Wallet tracking and webhooks
- Transaction parsing and analysis
- High-value transfer detection

### RateLimitManager
- API rate limit coordination
- Request scheduling and queuing
- Batch request handling
- Error recovery and retries

## 4. Key Features

### Twitter Monitoring
- Real-time tweet processing
- Content analysis for Solana mentions
- VIP account tracking
- Customizable notification routing

### Wallet Tracking
- Real-time transaction monitoring
- Swap and transfer detection
- High-value transaction alerts
- Token analytics integration

### Market Analysis
- Token price tracking
- Market cap monitoring
- Liquidity analysis
- Holder statistics

### Notifications
- Discord channel routing
- SMS alerts for high-value events
- Rich embeds with detailed data
- Customizable alert thresholds

## 5. Rate Limiting System

### Configuration
```javascript
twitter: {
    endpoints: {
        'users/by/username': {
            requestsPerWindow: 900,
            windowSizeMinutes: 15
        }
    },
    safetyMargin: 0.9
}
```

### Implementation Pattern
```javascript
await this.rateLimitManager.scheduleRequest(
    async () => {
        // API call
    },
    'endpoint_name'
);
```

## 6. Error Handling

### Standard Pattern
```javascript
try {
    await operation();
} catch (error) {
    if (error.code === 429) {
        await this.handleRateLimit(error);
    } else {
        await this.handleError(error);
    }
}
```

## 7. Configuration Management

### Environment Variables
Required in .env:
- Twitter API credentials
- Discord bot configuration
- Helius API configuration
- Channel IDs
- Twilio for SMS (optional)

### Config Validation
```javascript
function validateConfig() {
    const required = {
        twitter: ['apiKey', 'apiKeySecret'],
        discord: ['token', 'clientId'],
        helius: ['apiKey', 'webhookUrl']
    };
    // Validation logic
}
```

## 8. Best Practices

### Rate Limiting
1. Use RateLimitManager for ALL API calls
2. Include proper endpoint identification
3. Handle rate limit errors appropriately
4. Implement exponential backoff
5. Use safety margins (90% of limit)

### Error Handling
1. Catch and log all errors
2. Use appropriate error types
3. Implement recovery mechanisms
4. Maintain consistent error formats
5. Include debug information

### State Management
1. Track component state properly
2. Handle transitions safely
3. Implement recovery mechanisms
4. Maintain data consistency

## 9. Areas for Enhancement

### Short Term
1. Database integration for persistence
2. Comprehensive testing suite
3. Enhanced error recovery
4. Performance monitoring
5. API documentation

### Long Term
1. Clustering support
2. Advanced analytics
3. Machine learning integration
4. Extended market analysis
5. Custom alert rules

## 10. Development Guidelines

### Code Style
- Use ES6+ features
- Maintain consistent error handling
- Document complex logic
- Use TypeScript-style JSDoc
- Follow naming conventions

### Testing
- Unit test core functionality
- Integration test API interactions
- Test rate limit handling
- Verify webhook operations
- Monitor performance metrics

### Deployment
- Use Railway platform
- Configure auto-scaling
- Set up monitoring
- Enable error tracking
- Implement logging

## 11. Maintenance

### Regular Tasks
1. Update API credentials
2. Monitor rate limits
3. Check webhook health
4. Update token lists
5. Verify SMS delivery

### Monitoring
1. API usage tracking
2. Error rate monitoring
3. Response time tracking
4. Webhook reliability
5. SMS delivery rates

## 12. Security Considerations

### API Security
1. Secure credential storage
2. Rate limit protection
3. Request validation
4. Error message sanitization
5. Webhook verification

### Data Protection
1. No sensitive data logging
2. Secure configuration storage
3. Phone number encryption
4. Access control implementation
5. Regular security audits 