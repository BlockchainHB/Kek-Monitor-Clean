require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const TwitterMonitorBot = require('./core/TwitterMonitorBot');
const HeliusService = require('./core/HeliusService');
const BirdeyeService = require('./core/BirdeyeService');

// Validate required environment variables
if (!process.env.DISCORD_BOT_TOKEN) {
    console.error('❌ DISCORD_BOT_TOKEN is required but not set in environment variables');
    process.exit(1);    
}

console.log('🚀 Starting Twitter Monitor Bot...');
console.log('Environment:', process.env.NODE_ENV || 'development');

async function main() {
    try {
        // Initialize Discord client with required intents
        const client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });

        // Initialize services
        const heliusService = new HeliusService();
        const birdeyeService = new BirdeyeService();

        // Basic config
        const config = {
            guildId: process.env.DISCORD_GUILD_ID,
            tweetsChannelId: process.env.DISCORD_TWEETS_CHANNEL,
            vipChannelId: process.env.DISCORD_VIP_CHANNEL,
            walletsChannelId: process.env.DISCORD_WALLETS_CHANNEL,
            solanaChannelId: process.env.DISCORD_SOLANA_CHANNEL,
            monitoring: {
                interval: 60000 // 1 minute
            }
        };

        // Initialize bot with dependencies
        const bot = new TwitterMonitorBot({
            client,
            heliusService,
            birdeyeService,
            config
        });

        // Start the bot
        await bot.start();

    } catch (error) {
        console.error('Failed to start bot:', error);
        process.exit(1);
    }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled rejection:', error);
    process.exit(1);
});

main(); 