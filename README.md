# KEK Monitor Bot

A powerful Discord bot for monitoring Twitter accounts and Solana wallets, built by HB ([@onlyfun5](https://twitter.com/onlyfun5)) from [KEK Labs](https://twitter.com/keklabs_).

## Features

### Twitter Monitoring
- Real-time monitoring of specified Twitter accounts
- VIP account tracking with priority notifications
- Solana content detection and filtering
- Token address detection in tweets
- Customizable notification channels

### Wallet Tracking
- Real-time Solana wallet monitoring
- Transaction type detection (SWAP/TRANSFER)
- High-value transaction alerts
- Token analytics integration
- Custom wallet naming

### Market Analysis
- Token price tracking via Birdeye
- Market cap monitoring
- Liquidity analysis
- Holder statistics
- Price chart links

### Notifications
- Customizable Discord channels
- Rich embeds with detailed data
- SMS alerts for high-value transactions
- VIP notifications
- Configurable thresholds

## Installation

1. Clone the repository
```bash
git clone https://github.com/yourusername/kek-monitor.git
cd kek-monitor
```

2. Install dependencies
```bash
npm install
```

3. Configure environment variables
```bash
cp .env.example .env
# Edit .env with your configuration
```

4. Start the bot
```bash
npm start
```

## Configuration

### Required API Keys
- Discord Bot Token
- Twitter API v2 Credentials
- Helius API Key
- Birdeye API Key
- Twilio Credentials (optional, for SMS)

### Discord Channels
Configure the following channels in your Discord server:
- General tweet notifications
- VIP account tweets
- Wallet tracking notifications
- Solana-related content

## Commands

### Twitter Monitoring
- `/monitor <username>` - Monitor a Twitter account
- `/solanamonitor <username>` - Monitor for Solana content
- `/vipmonitor <username>` - Add VIP account monitoring
- `/stopmonitor <username>` - Stop monitoring account

### Wallet Tracking
- `/trackwallet <address> [name]` - Track a Solana wallet
- `/stopwallet <address>` - Stop tracking wallet

### Market Analysis
- `/trending` - View trending tokens
- `/gainers` - Top gaining tokens
- `/losers` - Top losing tokens
- `/volume` - Volume leaders
- `/security <token>` - Token security check
- `/metrics <token>` - Token metrics
- `/holders <token>` - Holder analysis

### Notifications
- `/smsalert <phone>` - Setup SMS alerts
- `/stopsms` - Disable SMS alerts

## Rate Limiting

The bot implements sophisticated rate limit handling:
- Twitter API v2 limits
- Helius API limits
- Birdeye API limits
- Batch processing
- Safety margins

## Development

### Scripts
- `npm run dev` - Run with nodemon
- `npm run lint` - Check code style
- `npm run lint:fix` - Fix code style
- `npm run check-limits` - Test rate limits

### Requirements
- Node.js >= 18.0.0
- NPM >= 7.0.0

## Credits

Built by HB ([@onlyfun5](https://twitter.com/onlyfun5)) from [KEK Labs](https://twitter.com/keklabs_)

### APIs Used
- [Twitter API v2](https://developer.twitter.com/en/docs/twitter-api)
- [Helius](https://helius.xyz/)
- [Birdeye](https://birdeye.so/)
- [Discord API](https://discord.com/developers/docs/intro)

## License

UNLICENSED - All rights reserved by KEK Labs

## Support

For support, follow and DM [@onlyfun5](https://twitter.com/onlyfun5) on Twitter 