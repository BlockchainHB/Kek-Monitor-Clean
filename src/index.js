require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const TwitterMonitorBot = require('./core/TwitterMonitorBot');
const BirdeyeService = require('./core/BirdeyeService');
const HeliusService = require('./core/HeliusService');
const config = require('./config/config');

async function main() {
    try {
        console.log('🚀 Starting Twitter Monitor Bot...');
        console.log('Environment:', process.env.NODE_ENV);

        // Initialize Discord client with required intents
        const client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });

        // Initialize services
        const birdeyeService = new BirdeyeService(config.birdeye.apiKey);
        const heliusService = new HeliusService(config.helius.apiKey, birdeyeService, config);

        // Initialize bot with dependencies
        const bot = new TwitterMonitorBot({
            client,  // Pass the Discord client
            heliusService,
            birdeyeService,
            config: config
        });

        // Start the bot
        await bot.start();

    } catch (error) {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    }
}

main(); 