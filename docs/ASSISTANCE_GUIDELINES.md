# AI Assistance Guidelines for Twitter Monitor Bot Project

## 1. Code Style & Conventions

### Core Principles
- Focus on isolated, minimal changes that fix specific issues
- Preserve existing code structure and patterns
- Maintain consistent error handling across all services

### Naming Conventions
- Services: PascalCase with descriptive suffixes (e.g., `HeliusService`)
- Methods: camelCase, action-based names (e.g., `handleWebhook`)
- Event Names: snake_case for event constants
- Variables: descriptive camelCase names

### Code Organization
```javascript
class ServiceName {
    constructor(dependencies) {
        this.validateDependencies(dependencies);
        this.initializeState();
    }

    // Core functionality methods first
    // Event handlers second
    // Utility methods last
}
```

## 2. Project Context

### Architecture Essentials
- Event-driven system using Node.js EventEmitter
- Centralized rate limit management
- In-memory state management (no database)
- Service-based modular design

### Critical Components
1. Rate Limit Management
   - ALL API calls must use RateLimitManager
   - Maintain safety margins
   - Handle rate limits properly

2. Event System
   - Use for inter-service communication
   - Maintain consistent event naming
   - Proper error propagation

3. State Management
   - Use Map objects for in-memory storage
   - Clear state transitions
   - Proper cleanup

## 3. Communication Preferences

### Preferred Style
- Focus on analytical, step-by-step explanations
- Identify core issues before suggesting solutions
- Provide isolated fixes without overengineering

### Level of Detail
- Detailed for critical changes
- Brief for routine fixes
- Always explain "why" for architectural decisions

### Response Format
1. Analysis of the issue
2. Specific code location
3. Proposed minimal fix
4. Verification of fix
5. Next steps if needed

## 4. Common Assistance Patterns

### Frequently Requested Help
1. Identifying inconsistencies in code
2. Rate limit handling improvements
3. Error handling standardization
4. Event system coordination
5. State management issues

### Preferred Approach
1. Analyze the specific issue
2. Identify minimal required changes
3. Preserve existing patterns
4. Make isolated fixes
5. Verify consistency

## 5. Assistance Boundaries

### High-Touch Areas
- Rate limit management
- Error handling patterns
- Event system coordination
- API integration issues

### Minimal Input Areas
- Feature additions
- Major refactoring
- Database implementation
- UI/UX changes

## 6. Recurring Challenges

### Common Issues
1. Rate limit coordination
2. Event handling consistency
3. State management
4. Error handling patterns
5. API integration

### Resolution Patterns
- Focus on isolated fixes
- Maintain existing patterns
- Ensure backward compatibility
- Preserve error handling

## 7. Domain Terminology

### Core Concepts
- **Rate Limiting**: API request management
- **Webhook**: Real-time data delivery
- **VIP Account**: Priority monitored Twitter account
- **High-Value Transaction**: Above threshold transfers
- **Token Analytics**: Market data analysis

### Service-Specific Terms
- **Birdeye**: Token price and market data
- **Helius**: Blockchain transaction monitoring
- **Twitter V2**: Twitter API version
- **Discord Embed**: Rich message format

## 8. Assistance Boundaries

### Do
- Focus on specific issues
- Make minimal, targeted changes
- Maintain existing patterns
- Explain critical changes

### Avoid
- Large refactoring
- New feature suggestions
- Pattern changes
- Database implementations
- UI modifications

## 9. Prioritization Framework

### Priority Order
1. Functional correctness
2. Rate limit compliance
3. Error handling
4. Performance
5. Code consistency

### Decision Factors
- Impact on existing functionality
- Rate limit implications
- Error handling requirements
- State management effects
- Event system coordination

## 10. Session Continuity

### Context Maintenance
- Reference previous fixes
- Track ongoing issues
- Maintain consistency in approaches
- Build on existing solutions

### Documentation
- Update relevant docs
- Note critical changes
- Track recurring patterns
- Document key decisions

## Quick Reference

### Critical Checks
- [ ] Uses RateLimitManager
- [ ] Proper error handling
- [ ] Event system coordination
- [ ] State management
- [ ] Pattern consistency

### Response Template
1. Issue Analysis
2. Code Location
3. Minimal Fix
4. Verification
5. Next Steps

### Key Principles
1. Isolated changes
2. Preserve patterns
3. Minimal intervention
4. Clear explanation
5. Proper verification 