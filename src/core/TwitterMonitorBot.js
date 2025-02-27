const { TwitterApi } = require('twitter-api-v2');
const { Client, GatewayIntentBits, ApplicationCommandOptionType, ChannelType } = require('discord.js');
const RateLimitManager = require('./RateLimitManager');
const DexScreenerService = require('./DexScreenerService');
const BirdeyeService = require('./BirdeyeService');
const twilio = require('twilio');
const HeliusService = require('./HeliusService');
const path = require('path');
const fs = require('fs');

class TwitterMonitorBot {
    constructor(dependencies) {
        this.validateDependencies(dependencies);
        
        // Initialize Discord client with required intents
        this.client = new Client({ 
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMembers
            ]
        });
        
        // Store core dependencies
        this.heliusService = dependencies.heliusService;
        this.birdeyeService = dependencies.birdeyeService;
        this.config = dependencies.config;

        // Initialize Twitter client
        this.twitter = new TwitterApi({
            appKey: this.config.twitter.apiKey,
            appSecret: this.config.twitter.apiKeySecret,
            accessToken: this.config.twitter.accessToken,
            accessSecret: this.config.twitter.accessTokenSecret
        });

        // Initialize rate limit manager with config
        this.rateLimitManager = new RateLimitManager(this.config.twitter.rateLimit);
        
        // Simple runtime state - no persistence
        this.monitoredAccounts = new Map();
        this.trackedWallets = new Map();
        this.smsSubscribers = new Map();
        this.processedTweets = new Set();
        this.lastSearchTime = new Map();
        this.tokenMentions = new Map();
        this.trackedTokens = new Map();

        // Initialize Twilio if credentials exist
        if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
            console.log('[DEBUG] Initializing Twilio with:', {
                accountSid: process.env.TWILIO_ACCOUNT_SID?.slice(0,4) + '...',
                phoneNumber: process.env.TWILIO_PHONE_NUMBER
            });
            this.twilio = twilio(
                process.env.TWILIO_ACCOUNT_SID,
                process.env.TWILIO_AUTH_TOKEN
            );
            this.twilioPhone = process.env.TWILIO_PHONE_NUMBER;
            console.log('✅ Twilio client initialized');
        } else {
            console.log('[DEBUG] Twilio not configured - missing:', {
                accountSid: !process.env.TWILIO_ACCOUNT_SID,
                authToken: !process.env.TWILIO_AUTH_TOKEN,
                phoneNumber: !process.env.TWILIO_PHONE_NUMBER
            });
        }

        // Initialize channel properties as null
        this.tweetsChannel = null;
        this.vipChannel = null;
        this.walletsChannel = null;
        this.solanaChannel = null;
    }

    validateDependencies(deps) {
        if (!deps.client) throw new Error('Discord client required');
        if (!deps.heliusService) throw new Error('HeliusService required');
        if (!deps.birdeyeService) throw new Error('BirdeyeService required');
        if (!deps.config) throw new Error('Config required');
        if (!deps.rateLimitManager) throw new Error('RateLimitManager required for Twitter operations');
    }

    async start() {
        try {
            // Validate channels
            await this.testChannelAccess();
            
            // Register commands
            await this.registerCommands();
            
            // Setup command handling
            this.setupCommandHandling();
            
            // Load tracked wallets
            await this.loadTrackedWallets();
            
            // Start monitoring
            await this.startMonitoring();
            
            console.log('TwitterMonitorBot started successfully');
        } catch (error) {
            console.error('Error starting TwitterMonitorBot:', error);
            throw error;
        }
    }

    async testChannelAccess() {
        try {
            console.log('[DEBUG] Testing channel access...');
            
            // Get guild
            const guild = this.client.guilds.cache.get(this.config.discord.guildId);
            if (!guild) {
                throw new Error(`Could not find guild with ID ${this.config.discord.guildId}`);
            }
            console.log('[DEBUG] Found guild:', guild.name);

            // Fetch all channels at once
            this.tweetsChannel = await guild.channels.fetch(this.config.discord.channels.tweets);
            this.vipChannel = await guild.channels.fetch(this.config.discord.channels.vip);
            this.walletsChannel = await guild.channels.fetch(this.config.discord.channels.wallets);
            this.solanaChannel = await guild.channels.fetch(this.config.discord.channels.solana);

            if (!this.tweetsChannel || !this.vipChannel || !this.walletsChannel || !this.solanaChannel) {
                throw new Error('One or more channels not found');
            }

            console.log('[DEBUG] ✅ All channels accessed successfully');
        } catch (error) {
            console.error('[DEBUG] Channel access error:', error);
            throw new Error(`Channel access failed - ${error.message}`);
        }
    }

    async getMonitoredAccounts() {
        return Array.from(this.monitoredAccounts.values());
    }

    async addMonitoredAccount(account) {
        this.monitoredAccounts.set(account.id, {
            ...account,
            lastTweetId: null
        });
        return true;
    }

    async removeMonitoredAccount(twitterId) {
        return this.monitoredAccounts.delete(twitterId);
    }

    async updateLastTweetId(twitterId, lastTweetId) {
        const account = this.monitoredAccounts.get(twitterId);
        if (account) {
            account.lastTweetId = lastTweetId;
            this.monitoredAccounts.set(twitterId, account);
        }
    }

    async isTweetProcessed(tweetId) {
        return this.processedTweets.has(tweetId);
    }

    async addProcessedTweet(tweet) {
        this.processedTweets.add(tweet.id);
    }

    async addTokenMention(tweetId, tokenAddress) {
        this.tokenMentions.set(tweetId, tokenAddress);
    }

    async addTrackedToken(address, tweetId) {
        if (!this.trackedTokens.has(address)) {
            this.trackedTokens.set(address, {
                address,
                first_seen_tweet_id: tweetId,
                created_at: new Date().toISOString()
            });
        }
    }

    async addSMSSubscriber(discordUserId, phoneNumber) {
        this.smsSubscribers.set(discordUserId, {
            phone: phoneNumber,
            discord_user_id: discordUserId
        });
        return true;
    }

    async removeSMSSubscriber(discordUserId) {
        return this.smsSubscribers.delete(discordUserId);
    }

    async getSMSSubscriber(discordUserId) {
        return this.smsSubscribers.get(discordUserId);
    }

    async getActiveSMSSubscribers() {
        return Array.from(this.smsSubscribers.values());
    }

    async checkAccount(username) {
        try {
            const cleanUsername = username.replace('@', '').trim();
            console.log(`[DEBUG] Looking up account for ${cleanUsername}...`);

            const accountData = await this.rateLimitManager.scheduleRequest(
                async () => {
                    const user = await this.twitter.v2.userByUsername(cleanUsername);
                    if (!user || !user.data) {
                        throw new Error(`No Twitter user found for username: ${cleanUsername}`);
                    }
                    return user.data;
                },
                'users/by/username'
            );

            if (!accountData) {
                console.log(`[DEBUG] No account found for ${cleanUsername}`);
                return null;
            }

            // Fetch tweets with rate limiting
            const tweets = await this.rateLimitManager.scheduleRequest(
                async () => {
                    return await this.twitter.v2.userTimeline(accountData.id, {
                        max_results: this.config.monitoring.maxTweetsPerAccount,
                        expansions: ['author_id', 'referenced_tweets.id'],
                        'tweet.fields': ['created_at', 'text', 'referenced_tweets']
                    });
                },
                'users/:id/tweets'
            );

            return {
                account: accountData,
                tweets: tweets.data || []
            };
        } catch (error) {
            console.error(`[ERROR] Failed to check account ${username}:`, error);
            throw error;
        }
    }

    extractSolanaAddresses(text) {
        // Just extract anything that looks like it could be an address
        const regex = /\S{30,50}/g;
        return text.match(regex) || [];
    }

    async processTweet(tweet, account, includes) {
        try {
            // Skip if already processed
            if (await this.isTweetProcessed(tweet.id)) {
                return;
            }

            // Get author info from includes
            const author = includes.users?.find(u => u.id === tweet.author_id);
            if (!author) {
                console.error('[ERROR] Author not found in includes:', tweet);
                return;
            }

            // Handle referenced tweet (reply/quote)
            let referencedTweet = null;
            if (tweet.referenced_tweets?.length > 0) {
                const ref = tweet.referenced_tweets[0];
                referencedTweet = includes.tweets?.find(t => t.id === ref.id);
                if (referencedTweet) {
                    const refAuthor = includes.users?.find(u => u.id === referencedTweet.author_id);
                    if (refAuthor) {
                        referencedTweet.author = refAuthor;
                    }
                }
            }

            // Create base embed
            const embed = {
                color: 0x1DA1F2, // Twitter blue
                author: {
                    name: `${author.name} (@${author.username})`,
                    icon_url: author.profile_image_url,
                    url: `https://twitter.com/${author.username}`
                },
                description: tweet.text,
                timestamp: tweet.created_at,
                footer: {
                    text: 'built by keklabs',
                    icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                }
            };

            // Add reply/quote content if exists
            if (referencedTweet && referencedTweet.author) {
                embed.fields = [{
                    name: `Replying to @${referencedTweet.author.username}`,
                    value: referencedTweet.text,
                    inline: false
                }];
            }

            // Check if VIP account
            const isVIP = this.monitoredAccounts.get(account.id)?.isVIP || false;
            
            // Extract any Solana addresses
            const solanaAddresses = this.extractSolanaAddresses(tweet.text);
            let hasSolanaContent = false;

            // Handle Solana token detection
            if (solanaAddresses.length > 0) {
                try {
                    for (const address of solanaAddresses) {
                        const tokenInfo = await this.birdeyeService.getTokenInfo(address);
                        if (tokenInfo) {
                            hasSolanaContent = true;
                            // Add token info to embed
                            embed.fields = embed.fields || [];
                            embed.fields.push({
                                name: `${tokenInfo.symbol} Token Info`,
                                value: `Price: $${this.formatNumber(tokenInfo.price)}\nMC: $${this.formatNumber(tokenInfo.marketCap)}\n24h Volume: $${this.formatNumber(tokenInfo.volume24h)}`,
                                inline: false
                            });
                            
                            // Store token mention for tracking
                            await this.addTokenMention(tweet.id, address);
                        }
                    }
                } catch (error) {
                    console.error('[ERROR] Birdeye token lookup failed:', error);
                }
            }

            // Send to appropriate channels
            try {
                // VIP tweets go to VIP channel and SMS
                if (isVIP) {
                    await this.vipChannel.send({ embeds: [embed] });
                    
                    // Send SMS to all subscribers for VIP tweets
                    const subscribers = await this.getActiveSMSSubscribers();
                    for (const subscriber of subscribers) {
                        await this.sendSMSAlert(
                            `🔥 VIP Alert: New tweet from @${author.username}\n${tweet.text}`,
                            subscriber.phone
                        );
                    }
                }
                
                // Solana tweets go to Solana channel
                if (hasSolanaContent) {
                    await this.solanaChannel.send({ embeds: [embed] });
                    
                    // Send SMS for Solana token alerts
                    const subscribers = await this.getActiveSMSSubscribers();
                    for (const subscriber of subscribers) {
                        await this.sendSMSAlert(
                            `💎 Solana Token Alert: @${author.username} mentioned ${solanaAddresses.length} token(s)\n${tweet.text}`,
                            subscriber.phone
                        );
                    }
                }
                
                // All tweets go to main tweets channel
                await this.tweetsChannel.send({ embeds: [embed] });

            } catch (error) {
                console.error('[ERROR] Failed to send tweet notifications:', error);
            }

            // Mark as processed
            await this.addProcessedTweet(tweet);

        } catch (error) {
            console.error('[ERROR] Process tweet error:', error);
        }
    }

    async sendTweetNotification(tweet) {
        try {
            const author = this.monitoredAccounts.get(tweet.author_id);
            if (!author) {
                console.error(`Author not found for tweet ${tweet.id}`);
                return;
            }

            // Get appropriate channel based on VIP status
            const channel = author.is_vip ? this.vipChannel : this.tweetsChannel;
            if (!channel) {
                console.error('Channel not found');
                return;
            }

            const tweetUrl = `https://twitter.com/${author.username}/status/${tweet.id}`;
            const profileData = JSON.parse(author.profile_data);

            // Create tweet embed
            const tweetEmbed = {
                color: author.is_vip ? 0xFFD700 : 0x1DA1F2,
                description: tweet.text,
                author: {
                    name: `${profileData.name || author.username} (@${author.username})`,
                    icon_url: profileData.profile_image_url || null,
                    url: `https://twitter.com/${author.username}`
                },
                footer: {
                    text: 'built by keklabs',
                    icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                },
                timestamp: new Date().toISOString()
            };

            // Check for media
            const imageUrl = this.getMediaUrl(tweet, tweet.includes);
            if (imageUrl) {
                tweetEmbed.image = { url: imageUrl };
            }

            // Check for Solana addresses in the tweet
            const addresses = this.extractSolanaAddresses(tweet.text);
            const embeds = [tweetEmbed];

            // If addresses found, add token embeds
            if (addresses.length > 0) {
                for (const address of addresses) {
                    const tokenInfo = await this.birdeyeService.getTokenInfo(address);
                    if (tokenInfo) {
                        const tokenEmbed = await this.birdeyeService.createTokenEmbed(tokenInfo.address, tokenInfo);
                        embeds.push(tokenEmbed);
                    }
                }
            }

            // Send notification with all embeds
            await channel.send({ 
                content: author.is_vip ? '@everyone New VIP Tweet! 🌟' : null,
                embeds: embeds,
                allowedMentions: { parse: ['everyone'] }
            });

            // Send SMS if enabled and VIP
            if (this.config.twilio.enabled && author.is_vip) {
                const subscribers = await this.getActiveSMSSubscribers();
                for (const subscriber of subscribers) {
                    let smsMessage = `🚨 VIP Tweet Alert!\n@${author.username}: ${tweet.text}\n\n${tweetUrl}`;
                    
                    // Add token info to SMS if present
                    if (addresses.length > 0) {
                        const tokenInfo = await this.birdeyeService.getTokenInfo(addresses[0]);
                        if (tokenInfo) {
                            smsMessage += `\n\nToken Info:\n` +
                                `${tokenInfo.symbol}\n` +
                                `Price: $${this.formatNumber(tokenInfo.priceUsd)}` +
                                (tokenInfo.marketCap ? `\nMC: $${this.formatNumber(tokenInfo.marketCap)}` : '');
                        }
                    }

                    await this.sendSMSAlert(
                        smsMessage,
                        subscriber.phone,
                        subscriber.discord_user_id
                    );
                }
            }

        } catch (error) {
            console.error('[ERROR] Error sending tweet notification:', error);
            throw error;
        }
    }

    async sendSolanaNotification(data) {
        const { tweet, account, includes, tokenInfo, address } = data;

        const embed = {
            title: '🔥 Solana Contract Detected',
            description: `Contract mentioned by ${account.username}`,
            fields: [
                {
                    name: '💰 Token Info',
                    value: [
                        `Symbol: ${tokenInfo.symbol}`,
                        `Price: $${this.formatNumber(tokenInfo.price)}`,
                        `Market Cap: $${this.formatNumber(tokenInfo.marketCap)}`,
                        `Liquidity: $${this.formatNumber(tokenInfo.liquidity)}`,
                        `Holders: ${this.formatNumber(tokenInfo.holders)}`,
                        `\n[📈 View Chart](https://dexscreener.com/solana/${address})`
                    ].join('\n'),
                    inline: false
                },
                {
                    name: '🔗 Links',
                    value: `[Tweet](https://twitter.com/${account.username}/status/${tweet.id})\n[Contract](https://solscan.io/token/${address})`,
                    inline: false
                }
            ],
            color: 0xFF0000,
            timestamp: new Date().toISOString()
        };

        // Send to appropriate channels with @everyone for contract detection
        if (this.solanaChannel) {
            await this.solanaChannel.send({
                content: '@everyone New Solana contract detected! 🚨',
                embeds: [embed],
                allowedMentions: { parse: ['everyone'] }
            });
        }
    }

    formatNumber(num) {
        if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
        if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
        if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
        return num.toFixed(2);
    }

    setupCommandHandling() {
        console.log('🔄 Setting up command handling...');
        
        this.client.on('interactionCreate', async interaction => {
            if (!interaction.isCommand() || !interaction.guildId) return;

            try {
                const commandName = interaction.commandName;
                console.log(`[DEBUG] Received command: ${commandName}`);

                switch (commandName) {
                    case 'monitor':
                        if (!interaction.replied) {
                            await this.handleMonitorCommand(interaction).catch(err => {
                                console.error('[ERROR] Monitor command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'solanamonitor':
                        if (!interaction.replied) {
                            await this.handleSolanaMonitorCommand(interaction).catch(err => {
                                console.error('[ERROR] Solana monitor command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'vipmonitor':
                        if (!interaction.replied) {
                            await this.handleVIPMonitorCommand(interaction).catch(err => {
                                console.error('[ERROR] VIP monitor command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'stopm':
                        if (!interaction.replied) {
                            await this.handleStopMonitorCommand(interaction).catch(err => {
                                console.error('[ERROR] Stop monitor command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'list':
                        if (!interaction.replied) {
                            await this.handleListCommand(interaction).catch(err => {
                                console.error('[ERROR] List command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'trackwallet':
                        if (!interaction.replied) {
                            await this.handleTrackWalletCommand(interaction).catch(err => {
                                console.error('[ERROR] Track wallet command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'stopwallet':
                        if (!interaction.replied) {
                            await this.handleStopWalletCommand(interaction).catch(err => {
                                console.error('[ERROR] Stop wallet command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'trending':
                        if (!interaction.replied) {
                            await this.handleTrendingCommand(interaction).catch(err => {
                                console.error('[ERROR] Trending command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'gainers':
                        if (!interaction.replied) {
                            await this.handleGainersCommand(interaction).catch(err => {
                                console.error('[ERROR] Gainers command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'losers':
                        if (!interaction.replied) {
                            await this.handleLosersCommand(interaction).catch(err => {
                                console.error('[ERROR] Losers command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'newpairs':
                        if (!interaction.replied) {
                            await this.handleNewPairsCommand(interaction).catch(err => {
                                console.error('[ERROR] New pairs command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'volume':
                        if (!interaction.replied) {
                            await this.handleVolumeCommand(interaction).catch(err => {
                                console.error('[ERROR] Volume command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'security':
                        if (!interaction.replied) {
                            await this.handleSecurityCommand(interaction).catch(err => {
                                console.error('[ERROR] Security command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'metrics':
                        if (!interaction.replied) {
                            await this.handleMetricsCommand(interaction).catch(err => {
                                console.error('[ERROR] Metrics command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'holders':
                        if (!interaction.replied) {
                            await this.handleHoldersCommand(interaction).catch(err => {
                                console.error('[ERROR] Holders command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'smsalert':
                        if (!interaction.replied) {
                            await this.handleSMSAlertCommand(interaction).catch(err => {
                                console.error('[ERROR] SMS alert command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'stopsms':
                        if (!interaction.replied) {
                            await this.handleStopSMSCommand(interaction).catch(err => {
                                console.error('[ERROR] Stop SMS command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'test':
                        if (!interaction.replied) {
                            await this.testNotifications(interaction).catch(err => {
                                console.error('[ERROR] Test command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'help':
                        if (!interaction.replied) {
                            await this.handleHelpCommand(interaction).catch(err => {
                                console.error('[ERROR] Help command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    default:
                        if (!interaction.replied) {
                            await interaction.reply({ 
                                content: '❌ Unknown command',
                                ephemeral: true 
                            });
                        }
                }
            } catch (error) {
                console.error('[ERROR] Command handling error:', error);
                if (!interaction.replied) {
                    await interaction.reply({
                        content: '❌ An error occurred while processing the command',
                        ephemeral: true
                    }).catch(console.error);
                }
            }
        });

        console.log('✅ Command handling setup complete');
    }

    async handleMonitorCommand(interaction) {
        try {
            const twitter_id = interaction.options.getString('twitter_id');
            if (!twitter_id) {
                await interaction.reply('Please provide a Twitter username to monitor.');
                return;
            }

            await interaction.deferReply();
            
            // Clean up username (remove @ if present and trim)
            const username = twitter_id.replace('@', '').trim();
            
            const account = await this.rateLimitManager.scheduleRequest(
                async () => {
                    const user = await this.twitter.v2.userByUsername(username);
                    return user.data;
                },
                'users/by/username'
            );

            if (!account) {
                await interaction.editReply('Could not find that Twitter account.');
                return;
            }

            // Add to monitored accounts and perform initial tweet fetch
            await this.addMonitoredAccount(account);

            await interaction.editReply(`✅ Now monitoring @${account.username}'s tweets!`);
        } catch (error) {
            console.error('Error handling monitor command:', error);
            await interaction.editReply('Failed to set up monitoring for that account.');
        }
    }

    async handleSolanaMonitorCommand(interaction) {
        try {
            await interaction.deferReply();
            const account = interaction.options.getString('twitter_id');

            // Validate account
            const accountData = await this.checkAccount(account);
            if (!accountData) {
                await interaction.editReply('❌ Invalid Twitter account. Please check the username and try again.');
                return;
            }

            // Store account with type 'solana'
            await this.addMonitoredAccount({
                id: accountData.id,
                username: accountData.username,
                monitor_type: 'solana',
                last_tweet_id: null
            });

            await interaction.editReply(`✅ Now monitoring Solana-related tweets from @${accountData.username}`);
            console.log(`[DEBUG] Added monitored account: ${accountData.username} (type: solana)`);

        } catch (error) {
            console.error('[ERROR] Solana monitor command error:', error);
            await interaction.editReply('❌ Failed to start monitoring. Please try again.');
        }
    }

    async handleVIPMonitorCommand(interaction) {
        try {
            const twitter_id = interaction.options.getString('twitter_id');
            if (!twitter_id) {
                await interaction.reply('Please provide a Twitter username to monitor.');
                return;
            }

            await interaction.deferReply();

            // Clean up username (remove @ if present and trim)
            const username = twitter_id.replace('@', '').trim();

            const account = await this.rateLimitManager.scheduleRequest(
                async () => {
                    const user = await this.twitter.v2.userByUsername(username);
                    return user.data;
                },
                'users/by/username'
            );

            if (!account) {
                await interaction.editReply('Could not find that Twitter account.');
                return;
            }

            // Add to monitored accounts with VIP flag
            await this.addMonitoredAccount({
                ...account,
                isVIP: true
            });

            await interaction.editReply(`✅ Now monitoring @${account.username}'s tweets as VIP!`);
        } catch (error) {
            console.error('Error handling VIP monitor command:', error);
            await interaction.editReply('Failed to set up VIP monitoring for that account.');
        }
    }

    async handleStopMonitorCommand(interaction) {
        try {
            const username = interaction.options.getString('twitter_id').toLowerCase().replace('@', '');

            // Check if account is being monitored
            const account = Array.from(this.monitoredAccounts.values())
                .find(a => a.username.toLowerCase() === username);

            if (!account) {
                return await interaction.reply({
                    embeds: [{
                        title: '❌ Account Not Found',
                        description: `@${username} is not currently being monitored.`,
                        color: 0xFF0000
                    }]
                });
            }

            // Remove account from monitoring
            await this.removeMonitoredAccount(account.id);

            return await interaction.reply({
                embeds: [{
                    title: '✅ Monitoring Stopped',
                    description: `Successfully stopped monitoring @${username}`,
                    fields: [
                        {
                            name: 'Account Type',
                            value: account.isVIP ? '⭐ VIP Account' : account.monitor_type === 'solana' ? '🔍 Solana Monitor' : '📝 Tweet Monitor',
                            inline: true
                        }
                    ],
                    color: 0x00FF00,
                    footer: {
                        text: 'built by keklabs',
                        icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                    }
                }]
            });

        } catch (error) {
            console.error('[ERROR] Stop monitor command error:', error);
            
            return await interaction.reply({
                embeds: [{
                    title: "Command Error",
                    description: `❌ An error occurred while stopping the monitor`,
                    color: 0xFF0000,
                    footer: {
                        text: 'built by keklabs',
                        icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                    }
                }]
            });
        }
    }

    async handleTrendingCommand(interaction) {
        try {
            await interaction.deferReply();

            console.log('[DEBUG] Fetching trending tokens...');
            const tokens = await this.birdeyeService.getTrendingTokens();
            
            if (!tokens || tokens.length === 0) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ No Data Available',
                        description: 'Could not fetch trending tokens at this time.',
                        color: 0xFF0000,
                        footer: {
                            text: 'built by keklabs',
                            icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                        }
                    }]
                });
            }

            console.log(`[DEBUG] Found ${tokens.length} trending tokens`);
            const embed = this.birdeyeService.createTrendingEmbed(tokens);
            return await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('[ERROR] Trending command error:', error);
            
            // Handle the reply based on the interaction state
            try {
                const errorEmbed = {
                    title: "Command Error",
                    description: "❌ Failed to fetch trending tokens",
                    color: 0xFF0000,
                    footer: {
                        text: 'built by keklabs',
                        icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                    }
                };

                if (!interaction.deferred && !interaction.replied) {
                    await interaction.reply({ embeds: [errorEmbed] });
                } else {
                    await interaction.editReply({ embeds: [errorEmbed] });
                }
            } catch (replyError) {
                console.error('[ERROR] Failed to send error message:', replyError);
            }
        }
    }

    async handleGainersCommand(interaction) {
        try {
            await interaction.deferReply();
            const timeframe = interaction.options.getString('timeframe') || '24h';
            
            const tokens = await this.birdeyeService.getTopMovers(timeframe, 'gainers');
            if (!tokens || tokens.length === 0) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ No Data Available',
                        description: 'Could not fetch top gainers at this time.',
                        color: 0xFF0000,
                        footer: {
                            text: 'built by keklabs',
                            icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                        }
                    }]
                });
            }

            const embed = this.birdeyeService.createMoversEmbed(tokens, 'gainers');
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[ERROR] Gainers command error:', error);
            await interaction.editReply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ Failed to fetch top gainers",
                    color: 0xFF0000,
                    footer: {
                        text: 'built by keklabs',
                        icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                    }
                }]
            });
        }
    }

    async handleLosersCommand(interaction) {
        try {
            await interaction.deferReply();
            const timeframe = interaction.options.getString('timeframe') || '24h';
            
            const tokens = await this.birdeyeService.getTopMovers(timeframe, 'losers');
            if (!tokens || tokens.length === 0) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ No Data Available',
                        description: 'Could not fetch top losers at this time.',
                        color: 0xFF0000,
                        footer: {
                            text: 'built by keklabs',
                            icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                        }
                    }]
                });
            }

            const embed = this.birdeyeService.createMoversEmbed(tokens, 'losers');
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[ERROR] Losers command error:', error);
            await interaction.editReply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ Failed to fetch top losers",
                    color: 0xFF0000,
                    footer: {
                        text: 'built by keklabs',
                        icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                    }
                }]
            });
        }
    }

    async handleNewPairsCommand(interaction) {
        try {
            await interaction.deferReply();
            const hours = interaction.options.getInteger('hours') || 24;
            
            const pairs = await this.birdeyeService.getNewPairs(hours);
            if (!pairs.length) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ No Data Available',
                        description: 'Could not fetch new pairs at this time.',
                        color: 0xFF0000,
                        footer: {
                            text: 'built by keklabs',
                            icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                        }
                    }]
                });
            }

            const embed = this.birdeyeService.createNewPairsEmbed(pairs);
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[ERROR] New pairs command error:', error);
            await interaction.editReply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ Failed to fetch new pairs",
                    color: 0xFF0000,
                    footer: {
                        text: 'built by keklabs',
                        icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                    }
                }]
            });
        }
    }

    async handleVolumeCommand(interaction) {
        try {
            await interaction.deferReply();
            const timeframe = interaction.options.getString('timeframe') || '24h';
            
            const tokens = await this.birdeyeService.getVolumeLeaders(timeframe);
            if (!tokens.length) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ No Data Available',
                        description: 'Could not fetch volume leaders at this time.',
                        color: 0xFF0000,
                        footer: {
                            text: 'built by keklabs',
                            icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                        }
                    }]
                });
            }

            const embed = this.birdeyeService.createVolumeEmbed(tokens);
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[ERROR] Volume command error:', error);
            await interaction.editReply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ Failed to fetch volume leaders",
                    color: 0xFF0000,
                    footer: {
                        text: 'built by keklabs',
                        icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                    }
                }]
            });
        }
    }

    async handleHelpCommand(interaction) {
        try {
            const embed = {
                title: '🐈‍⬛ kek-monitor by keklabs',
                description: 'Available commands:',
                color: 0x9945FF,
                fields: [
                    {
                        name: '📱 Twitter Monitoring',
                        value: `
\`/monitor\` - Start monitoring a Twitter account
\`/stopm\` - Stop monitoring a Twitter account
\`/vipmonitor\` - Start monitoring a VIP Twitter account
\`/list\` - List all monitored accounts`,
                        inline: false
                    },
                    {
                        name: '👛 Wallet Tracking',
                        value: `
\`/trackwallet\` - Track a Solana wallet's transactions
\`/stopwallet\` - Stop tracking a wallet
\`/list\` - List all tracked wallets`,
                        inline: false
                    },
                    {
                        name: '📊 Market Data',
                        value: `
\`/trending\` - Show trending tokens
\`/gainers\` - Show top gainers
\`/volume\` - Show top volume tokens`,
                        inline: false
                    },
                    {
                        name: '🔍 Token Analysis',
                        value: `
\`/metrics\` - Show detailed token metrics
\`/holders\` - Show holder information
\`/security\` - Show security analysis`,
                        inline: false
                    },
                    {
                        name: '📲 Notifications',
                        value: `
\`/smsalert\` - Register phone for SMS alerts
\`/stopsms\` - Unsubscribe from SMS alerts
\`/test\` - Test notifications`,
                        inline: false
                    }
                ],
                footer: {
                    text: 'built by keklabs',
                    icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                },
                timestamp: new Date().toISOString()
            };

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('[ERROR] Help command error:', error);
            await interaction.reply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ Failed to display help information",
                    color: 0xFF0000,
                    footer: {
                        text: 'built by keklabs',
                        icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                    }
                }]
            });
        }
    }

    async handleSecurityCommand(interaction) {
        try {
            await interaction.deferReply();
            const address = interaction.options.getString('address');
            
            const securityData = await this.birdeyeService.getTokenSecurity(address);
            if (!securityData) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ No Data Available',
                        description: 'Could not fetch security information for this token.',
                        color: 0xFF0000,
                        footer: {
                            text: 'built by keklabs',
                            icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                        }
                    }]
                });
            }

            const embed = this.birdeyeService.createSecurityEmbed(address, securityData);
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[ERROR] Security command error:', error);
            await interaction.editReply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ Failed to fetch security information",
                    color: 0xFF0000,
                    footer: {
                        text: 'built by keklabs',
                        icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                    }
                }]
            });
        }
    }

    async handleMetricsCommand(interaction) {
        try {
            await interaction.deferReply();
            const address = interaction.options.getString('address');
            
            const metricsData = await this.birdeyeService.getTokenMetrics(address);
            if (!metricsData) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ No Data Available',
                        description: 'Could not fetch metrics information for this token.',
                        color: 0xFF0000,
                        footer: {
                            text: 'built by keklabs',
                            icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                        }
                    }]
                });
            }

            const embed = this.birdeyeService.createMetricsEmbed(address, metricsData);
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[ERROR] Metrics command error:', error);
            await interaction.editReply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ Failed to fetch metrics information",
                    color: 0xFF0000,
                    footer: {
                        text: 'built by keklabs',
                        icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                    }
                }]
            });
        }
    }

    async handleHoldersCommand(interaction) {
        try {
            await interaction.deferReply();
            const address = interaction.options.getString('address');
            
            // Fetch both holders and traders data concurrently
            const [holders, traders] = await Promise.all([
                this.birdeyeService.getTokenHolders(address),
                this.birdeyeService.getTokenTopTraders(address)
            ]);

            if (!holders) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ No Data Available',
                        description: 'Could not fetch holder information for this token.',
                        color: 0xFF0000,
                        footer: {
                            text: 'built by keklabs',
                            icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                        }
                    }]
                });
            }

            const embed = this.birdeyeService.createHoldersEmbed(address, holders, traders);
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[ERROR] Holders command error:', error);
            await interaction.editReply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ Failed to fetch holder information",
                    color: 0xFF0000,
                    footer: {
                        text: 'built by keklabs',
                        icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                    }
                }]
            });
        }
    }

    async handleSMSAlertCommand(interaction) {
        try {
            await interaction.deferReply({ flags: ['Ephemeral'] });
            
            if (!this.twilio || !this.twilioPhone) {
                await interaction.editReply({ 
                    content: '❌ SMS alerts are not configured. Please contact the administrator.',
                    flags: ['Ephemeral']
                });
                return;
            }

            const phone = interaction.options.getString('phone');
            const userId = interaction.user.id;

            // Store in memory
            this.smsSubscribers.set(userId, {
                phone: phone,
                discord_id: userId
            });

            // Send test message
            await this.sendSMSAlert('🔔 SMS alerts configured successfully! You will now receive notifications for high-value transactions.', phone);

            await interaction.editReply({ 
                content: '✅ SMS alerts configured successfully! You should receive a test message shortly.',
                flags: ['Ephemeral']
            });
            console.log(`[DEBUG] Added SMS subscriber: ${userId} with phone: ${phone}`);

        } catch (error) {
            console.error('[ERROR] SMS alert command error:', error);
            await interaction.editReply({ 
                content: '❌ Failed to configure SMS alerts. Please try again.',
                flags: ['Ephemeral']
            });
        }
    }

    async handleStopSMSCommand(interaction) {
        try {
            await interaction.deferReply({ flags: ['Ephemeral'] });
            const phone = interaction.options.getString('phone');

            // Remove from in-memory state
            let removed = false;
            for (const [userId, data] of this.smsSubscribers.entries()) {
                if (data.phone === phone) {
                    this.smsSubscribers.delete(userId);
                    removed = true;
                    break;
                }
            }

            if (removed) {
                await interaction.editReply('✅ Successfully unsubscribed from SMS alerts.');
                console.log(`[DEBUG] Removed SMS subscription for phone: ${phone}`);
            } else {
                await interaction.editReply('❌ No SMS subscription found for this phone number.');
            }

        } catch (error) {
            console.error('[ERROR] Stop SMS command error:', error);
            await interaction.editReply({ 
                content: '❌ Failed to unsubscribe from SMS alerts. Please try again.',
                flags: ['Ephemeral']
            });
        }
    }

    async testNotifications(interaction) {
        try {
            await interaction.deferReply();
            
            const services = [];
            const tests = [];
            
            // Test Discord Connection & Permissions
            services.push('💬 Discord: Connected');
            try {
                await interaction.channel.send('🔄 Testing message permissions...');
                services.push('✅ Discord Permissions: OK');
            } catch (error) {
                services.push('❌ Discord Permissions: Failed');
                tests.push(`Discord Error: ${error.message}`);
            }

            // Test Channel Access
            const channels = {
                '📢 Tweets': this.tweetsChannel,
                '⭐ VIP': this.vipChannel,
                '👛 Wallets': this.walletsChannel,
                '💎 Solana': this.solanaChannel
            };

            for (const [name, channel] of Object.entries(channels)) {
                if (channel && channel.id) {
                    services.push(`✅ ${name} Channel: ${channel.name}`);
                } else {
                    services.push(`❌ ${name} Channel: Not Found`);
                }
            }

            // Test SMS Configuration
            if (this.twilio && this.twilioPhone) {
                services.push('✅ SMS: Configured');
                services.push(`📱 SMS Number: ${this.twilioPhone}`);
            } else {
                services.push('❌ SMS: Not Configured');
            }

            // Test Birdeye API
            try {
                await this.birdeyeService.getTrendingTokens();
                services.push('✅ Birdeye API: Connected');
            } catch (error) {
                services.push('❌ Birdeye API: Failed');
                tests.push(`Birdeye Error: ${error.message}`);
            }

            // Test Helius API
            try {
                await this.heliusService.testConnection();
                services.push('✅ Helius API: Connected');
            } catch (error) {
                services.push('❌ Helius API: Failed');
                tests.push(`Helius Error: ${error.message}`);
            }

            // Monitor Stats
            const stats = [
                `📊 Monitored Accounts: ${this.monitoredAccounts.size}`,
                `👛 Tracked Wallets: ${this.trackedWallets.size}`,
                `📱 SMS Subscribers: ${this.smsSubscribers.size}`,
                `🔄 Monitoring Interval: ${this.config.monitoring.interval}ms`
            ];

            // Create embed
            const embed = {
                title: '🤖 Bot Status Report',
                color: tests.length > 0 ? 0xFFA500 : 0x00FF00, // Orange if errors, green if all good
                fields: [
                    {
                        name: '📡 Services',
                        value: services.join('\n'),
                        inline: false
                    },
                    {
                        name: '📈 Statistics',
                        value: stats.join('\n'),
                        inline: false
                    }
                ],
                footer: {
                    text: 'built by keklabs',
                    icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                },
                timestamp: new Date().toISOString()
            };

            // Add test failures if any occurred
            if (tests.length > 0) {
                embed.fields.push({
                    name: '⚠️ Test Failures',
                    value: tests.join('\n'),
                    inline: false
                });
            }

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('[ERROR] Test notification error:', error);
            await interaction.editReply({
                embeds: [{
                    title: '❌ Test Failed',
                    description: 'Error running tests',
                    color: 0xFF0000,
                    footer: {
                        text: 'built by keklabs',
                        icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                    }
                }]
            });
        }
    }

    async sendSMSAlert(message, phone, discord_user_id = null) {
        try {
            if (!this.twilio || !this.twilioPhone) {
                console.error('[ERROR] Twilio not configured');
                return false;
            }

            await this.twilio.messages.create({
                body: message,
                from: this.twilioPhone,
                to: phone
            });

            console.log(`[DEBUG] SMS alert sent to ${phone}`);
            return true;
        } catch (error) {
            console.error('[ERROR] Failed to send SMS alert:', error);
            return false;
        }
    }

    async registerCommands() {
        try {
            console.log('🔄 Checking application commands...');
            
            // Get the guild
            const guild = await this.client.guilds.fetch(this.config.discord.guildId);
            if (!guild) {
                throw new Error(`Could not find guild with ID ${this.config.discord.guildId}`);
            }

            console.log(`Found guild: ${guild.name}`);

            // Check existing commands
            const existingCommands = await guild.commands.fetch();
            if (existingCommands.size > 0) {
                console.log('✅ Commands already registered, skipping registration');
                return;
            }

            console.log('📝 Registering new commands...');

            const commands = [
                {
                    name: 'monitor',
                    description: 'Monitor a Twitter account for tweets',
                    options: [{
                            name: 'twitter_id',
                            description: 'Twitter username to monitor',
                        type: ApplicationCommandOptionType.String,
                            required: true
                    }]
                },
                {
                    name: 'solanamonitor',
                    description: 'Monitor a Twitter account for Solana addresses',
                    options: [{
                        name: 'twitter_id',
                        description: 'Twitter username to monitor for Solana addresses',
                        type: ApplicationCommandOptionType.String,
                        required: true
                    }]
                },
                {
                    name: 'vipmonitor',
                    description: 'Monitor a VIP Twitter account',
                    options: [{
                        name: 'twitter_id',
                        description: 'Twitter username to monitor as VIP',
                        type: ApplicationCommandOptionType.String,
                        required: true
                    }]
                },
                {
                    name: 'stopm',
                    description: 'Stop monitoring a Twitter account',
                    options: [{
                            name: 'twitter_id',
                            description: 'Twitter username to stop monitoring',
                        type: ApplicationCommandOptionType.String,
                            required: true
                    }]
                },
                {
                    name: 'list',
                    description: 'List all monitored accounts'
                },
                {
            name: 'trackwallet',
            description: 'Track a Solana wallet',
                    options: [{
                        name: 'wallet',
                    description: 'Solana wallet address to track',
                        type: ApplicationCommandOptionType.String,
                    required: true
                    }]
                },
                {
            name: 'stopwallet',
                    description: 'Stop tracking a Solana wallet',
                    options: [{
                        name: 'wallet',
                    description: 'Solana wallet address to stop tracking',
                        type: ApplicationCommandOptionType.String,
                    required: true
                    }]
                },
                {
                    name: 'trending',
                    description: 'Get trending tokens',
                    options: [{
                        name: 'timeframe',
                        description: 'Timeframe for trending data',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                        choices: [
                            { name: '1h', value: '1h' },
                            { name: '6h', value: '6h' },
                            { name: '24h', value: '24h' }
                        ]
                    }]
                },
                {
                    name: 'gainers',
                    description: 'Get top gainers',
                    options: [{
                            name: 'timeframe',
                        description: 'Timeframe for gainers data',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                            choices: [
                            { name: '1h', value: '1h' },
                            { name: '6h', value: '6h' },
                            { name: '24h', value: '24h' }
                        ]
                    }]
                },
                {
                    name: 'losers',
                    description: 'Get top losers',
                    options: [{
                            name: 'timeframe',
                        description: 'Timeframe for losers data',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                            choices: [
                            { name: '1h', value: '1h' },
                            { name: '6h', value: '6h' },
                            { name: '24h', value: '24h' }
                        ]
                    }]
                },
                {
                    name: 'newpairs',
                    description: 'Get new trading pairs',
                    options: [{
                        name: 'timeframe',
                        description: 'Timeframe for new pairs data',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                        choices: [
                            { name: '1h', value: '1h' },
                            { name: '6h', value: '6h' },
                            { name: '24h', value: '24h' }
                        ]
                    }]
                },
                {
                    name: 'volume',
                    description: 'Get volume leaders',
                    options: [{
                            name: 'timeframe',
                        description: 'Timeframe for volume data',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                            choices: [
                            { name: '1h', value: '1h' },
                            { name: '6h', value: '6h' },
                            { name: '24h', value: '24h' }
                        ]
                    }]
                },
                {
                    name: 'security',
                    description: 'Get token security info',
                    options: [{
                            name: 'address',
                        description: 'Token address to check',
                        type: ApplicationCommandOptionType.String,
                            required: true
                    }]
                },
                {
                    name: 'metrics',
                    description: 'Get token metrics',
                    options: [{
                            name: 'address',
                        description: 'Token address to check',
                        type: ApplicationCommandOptionType.String,
                            required: true
                    }]
                },
                {
                    name: 'holders',
                    description: 'Get token holder info',
                    options: [{
                            name: 'address',
                        description: 'Token address to check',
                        type: ApplicationCommandOptionType.String,
                            required: true
                    }]
                },
                {
                    name: 'smsalert',
                    description: 'Subscribe to SMS alerts',
                    options: [{
                            name: 'phone',
                        description: 'Phone number (E.164 format)',
                        type: ApplicationCommandOptionType.String,
                            required: true
                    }]
                },
                {
                    name: 'stopsms',
                    description: 'Unsubscribe from SMS alerts'
                },
                {
                    name: 'test',
                    description: 'Test notifications'
                },
                {
                    name: 'help',
                    description: 'Show help information'
                }
            ];

            // Only register if no commands exist
            await guild.commands.set(commands);
            console.log('✅ Application commands registered successfully');
        } catch (error) {
            console.error('❌ Error checking/registering commands:', error);
            // Don't throw error, just log it - this allows the bot to continue if commands already exist
            console.log('Continuing bot startup...');
        }
    }

    async handleCommand(interaction) {
        // Only handle slash commands from our guild
        if (!interaction.isCommand() || interaction.guildId !== config.discord.guildId) return;

        // Simple command handling
        try {
            const command = interaction.commandName;
            console.log(`[DEBUG] Received command: ${command} from ${interaction.user.tag}`);

            switch (command) {
                case 'monitor':
                    if (!interaction.replied) {
                        await this.handleMonitorCommand(interaction);
                    }
                    break;
                case 'stopm':
                    if (!interaction.replied) {
                        await this.handleStopMonitorCommand(interaction);
                    }
                    break;
                case 'list':
                    if (!interaction.replied) {
                        await this.handleListCommand(interaction);
                    }
                    break;
                case 'test':
                    if (!interaction.replied) {
                        await this.testNotifications(interaction);
                    }
                    break;
                case 'vipmonitor':
                    if (!interaction.replied) {
                        await this.handleVIPMonitorCommand(interaction).catch(err => {
                            console.error('[ERROR] VIP monitor command failed:', err);
                            throw err;
                        });
                    }
                    break;
                case 'trending':
                    if (!interaction.replied) {
                        await this.handleTrendingCommand(interaction);
                    }
                    break;
                case 'gainers':
                    if (!interaction.replied) {
                        await this.handleGainersCommand(interaction);
                    }
                    break;
                case 'losers':
                    if (!interaction.replied) {
                        await this.handleLosersCommand(interaction);
                    }
                    break;
                case 'newpairs':
                    if (!interaction.replied) {
                        await this.handleNewPairsCommand(interaction);
                    }
                    break;
                case 'volume':
                    if (!interaction.replied) {
                        await this.handleVolumeCommand(interaction);
                    }
                    break;
                case 'help':
                    if (!interaction.replied) {
                        await this.handleHelpCommand(interaction);
                    }
                    break;
                case 'security':
                    if (!interaction.replied) {
                        await this.handleSecurityCommand(interaction);
                    }
                    break;
                case 'metrics':
                    if (!interaction.replied) {
                        await this.handleMetricsCommand(interaction);
                    }
                    break;
                case 'holders':
                    if (!interaction.replied) {
                        await this.handleHoldersCommand(interaction);
                    }
                    break;
                case 'smsalert':
                    if (!interaction.replied) {
                        await this.handleSMSAlertCommand(interaction);
                    }
                    break;
                case 'stopsms':
                    if (!interaction.replied) {
                        await this.handleStopSMSCommand(interaction);
                    }
                    break;
                case 'trackwallet':
                    if (!interaction.replied) {
                        await this.handleTrackWalletCommand(interaction);
                    }
                    break;
                case 'stopwallet':
                    if (!interaction.replied) {
                        await this.handleStopWalletCommand(interaction);
                    }
                    break;
                default:
                    if (!interaction.replied) {
                        await interaction.reply('Unknown command');
                    }
            }
        } catch (error) {
            console.error('Command error:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    embeds: [{
                        title: "Error",
                        description: "❌ Command failed to execute",
                        color: 0xFF0000
                    }]
                });
            }
        }
    }

    async setupHeliusWebhook() {
        try {
            console.log('[DEBUG] Setting up Helius webhook...');

            // Get currently tracked wallets
            const walletAddresses = Array.from(this.trackedWallets.keys());
            if (walletAddresses.length === 0) {
                console.log('[DEBUG] No wallets to track, skipping webhook setup');
                return;
            }

            // Update webhook with current wallets
            await this.heliusService.updateWebhookAddresses(walletAddresses);
            console.log('[DEBUG] Helius webhook updated with current wallets');

        } catch (error) {
            console.error('[ERROR] Failed to setup Helius webhook:', error);
            throw error;
        }
    }

    // Simplified wallet monitoring
    startWalletMonitoring() {
        console.log(`[DEBUG] Wallet monitoring active - ${this.trackedWallets.size} wallets configured`);
        console.log('[DEBUG] Webhook endpoint ready for Helius notifications');
    }

    async handleTrackWalletCommand(interaction) {
        const address = interaction.options.getString('wallet');
        const name = interaction.options.getString('name');

        try {
            if (!this.heliusService.isValidSolanaAddress(address)) {
                await interaction.reply('Please provide a valid Solana wallet address.');
                return;
            }

            // Store in memory
            this.trackedWallets.set(address, {
                address,
                name: name || address.slice(0, 4) + '...' + address.slice(-4),
                added_by: interaction.user.id
            });

            // Update Helius service wallet name mapping
            this.heliusService.setWalletName(address, name || address.slice(0, 4) + '...' + address.slice(-4));

            await interaction.reply(`✅ Now tracking wallet: ${name || address}`);
        } catch (error) {
            console.error('Error handling track wallet command:', error);
            await interaction.reply('Failed to track wallet.');
        }
    }

    async handleStopWalletCommand(interaction) {
        try {
            const address = interaction.options.getString('wallet');

            if (!this.trackedWallets.has(address)) {
                await interaction.reply('This wallet is not being tracked.');
                return;
            }

            // Remove from memory
            this.trackedWallets.delete(address);

            await interaction.reply(`✅ Stopped tracking wallet: ${address}`);
        } catch (error) {
            console.error('Error handling stop wallet command:', error);
            await interaction.reply('Failed to stop tracking wallet.');
        }
    }

    // Handle webhook events from Helius
    async handleWebhook(data) {
        try {
            console.log('[DEBUG] Received webhook data:', JSON.stringify(data, null, 2));

            // Get the wallet channel
            const channel = this.walletsChannel;
            if (!channel) {
                console.error('[ERROR] Wallet notification channel not found');
                return;
            }

            // Process each transaction
            for (const transaction of data) {
                try {
                    // Get wallet info from tracked wallets
                    const wallet = this.trackedWallets.get(transaction.account);
                    if (!wallet) {
                        console.log('[DEBUG] Transaction for untracked wallet:', transaction.account);
                        continue;
                    }

                    // Calculate total USD value
                    let totalUsdValue = 0;
                    let isStablecoinPurchase = false;
                    
                    // Create transaction embed first
                    const embed = {
                        title: '🔔 New Transaction',
                        description: `Activity detected for wallet:\n\`${transaction.account}\``,
                        color: 0x9945FF,
                        fields: [
                            {
                                name: 'Transaction Type',
                                value: transaction.type || 'Unknown',
                                inline: true
                            }
                        ],
                        footer: {
                            text: 'built by keklabs',
                            icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                        },
                        timestamp: new Date().toISOString()
                    };

                    // Check if there are token transfers once
                    const hasTokenTransfers = transaction.tokenTransfers?.length > 0;
                    const tokenTransfers = hasTokenTransfers ? transaction.tokenTransfers : [];
                    
                    // Check for stablecoin purchases first
                    if (hasTokenTransfers) {
                        for (const transfer of tokenTransfers) {
                            const stablecoins = ['USDC', 'USDT', 'DAI', 'BUSD'];
                            if (stablecoins.includes(transfer.tokenSymbol?.toUpperCase())) {
                                isStablecoinPurchase = true;
                                console.log('[DEBUG] Skipping stablecoin purchase transaction');
                                break;
                            }
                        }
                    }

                    // Skip early if it's a stablecoin purchase
                    if (isStablecoinPurchase) {
                        continue;
                    }
                    
                    // Add SOL value if present
                    if (transaction.amount && transaction.nativeTransfers) {
                        const solPrice = await this.heliusService.getSolanaPrice();
                        totalUsdValue += transaction.amount * solPrice;

                        // Add SOL amount to embed
                        embed.fields.push({
                            name: 'SOL Amount',
                            value: `${this.formatNumber(transaction.amount)} SOL`,
                            inline: true
                        });
                    }

                    // Now process token transfer values
                    if (hasTokenTransfers) {
                        for (const transfer of tokenTransfers) {
                            if (transfer.tokenPrice) {
                                totalUsdValue += transfer.tokenAmount * transfer.tokenPrice;
                            }
                        }
                    }

                    // Update embed title and color based on final total value
                    if (totalUsdValue >= 1000) {
                        embed.title = '🔥 High Value Transaction';
                        embed.color = 0xFF0000;
                    }

                    // Add USD value
                    embed.fields.push({
                        name: 'Estimated Value',
                        value: `$${this.formatNumber(totalUsdValue)}`,
                        inline: true
                    });

                    // Add transaction URL
                    if (transaction.signature) {
                        embed.description += `\n\n[View Transaction](https://solscan.io/tx/${transaction.signature})`;
                    }

                    // Add token info if available
                    if (hasTokenTransfers) {
                        const tokenTransfer = tokenTransfers[0];
                        
                        // Get enhanced token info from Birdeye
                        let tokenInfo = null;
                        const tokenFields = [];
                        
                        try {
                            tokenInfo = await this.birdeyeService.getTokenInfo(tokenTransfer.mint);
                        } catch (error) {
                            console.error('[ERROR] Failed to fetch Birdeye data:', error);
                        }

                        // Add token section header
                        embed.fields.push({
                            name: '💎 Token Information',
                            value: '─'.repeat(20),
                            inline: false
                        });
                        
                        // Add token info fields
                        tokenFields.push(
                            {
                                name: 'Token',
                                value: tokenTransfer.tokenName || 'Unknown Token',
                                inline: true
                            },
                            {
                                name: 'Token Amount',
                                value: `${this.formatNumber(tokenTransfer.tokenAmount)} ${tokenTransfer.tokenSymbol || ''}`,
                                inline: true
                            }
                        );
                        
                        // Add Birdeye metrics if available
                        if (tokenInfo) {
                            if (tokenInfo.marketCap) tokenFields.push({
                                name: 'Market Cap',
                                value: `$${this.formatNumber(tokenInfo.marketCap)}`,
                                inline: true
                            });
                            if (tokenInfo.liquidity) tokenFields.push({
                                name: 'Liquidity',
                                value: `$${this.formatNumber(tokenInfo.liquidity)}`,
                                inline: true
                            });
                            if (tokenInfo.holders) tokenFields.push({
                                name: 'Holders',
                                value: this.formatNumber(tokenInfo.holders),
                                inline: true
                            });
                            if (tokenInfo.volume24h) tokenFields.push({
                                name: '24h Volume',
                                value: `$${this.formatNumber(tokenInfo.volume24h)}`,
                                inline: true
                            });
                            
                            // Add price change metrics
                            if (tokenInfo.priceChange1h) tokenFields.push({
                                name: '1h Change',
                                value: `${tokenInfo.priceChange1h > 0 ? '📈' : '📉'} ${tokenInfo.priceChange1h.toFixed(2)}%`,
                                inline: true
                            });
                            if (tokenInfo.priceChange24h) tokenFields.push({
                                name: '24h Change',
                                value: `${tokenInfo.priceChange24h > 0 ? '📈' : '📉'} ${tokenInfo.priceChange24h.toFixed(2)}%`,
                                inline: true
                            });
                            
                            // Add trading activity metrics
                            if (tokenInfo.trades24h && tokenInfo.buys24h) {
                                const buyRatio = ((tokenInfo.buys24h / tokenInfo.trades24h) * 100).toFixed(1);
                                tokenFields.push({
                                    name: 'Buy Pressure',
                                    value: `${buyRatio}% (${tokenInfo.buys24h}/${tokenInfo.trades24h} trades)`,
                                    inline: true
                                });
                            }
                            
                            // Add unique wallet activity
                            if (tokenInfo.uniqueWallets24h) tokenFields.push({
                                name: 'Active Wallets 24h',
                                value: this.formatNumber(tokenInfo.uniqueWallets24h),
                                inline: true
                            });
                        }
                        
                        embed.fields.push(...tokenFields);
                    }

                    // Send notification to Discord
                    await channel.send({ embeds: [embed] });

                    // Send SMS only if value is over $1000 and SMS is enabled
                    if (totalUsdValue >= 1000 && this.config.twilio.enabled && wallet.added_by) {
                        const subscriber = await this.getSMSSubscriber(wallet.added_by);
                        if (subscriber) {
                            const smsMessage = `🔥 High Value Transaction ($${this.formatNumber(totalUsdValue)})!\n` +
                                `Type: ${transaction.type || 'Unknown'}\n` +
                                ((transaction.amount && transaction.nativeTransfers) ? `SOL Amount: ${this.formatNumber(transaction.amount)} SOL\n` : '') +
                                (transaction.tokenTransfers?.[0] ? `Token: ${transaction.tokenTransfers[0].tokenSymbol}\n` : '') +
                                (transaction.signature ? `\nhttps://solscan.io/tx/${transaction.signature}` : '');

                            await this.sendSMSAlert(
                                smsMessage,
                                subscriber.phone,
                                wallet.added_by
                            );
                        }
                    }
                } catch (txError) {
                    console.error('[ERROR] Error processing transaction:', txError);
                    continue;
                }
            }
        } catch (error) {
            console.error('[ERROR] Error handling webhook:', error);
        }
    }

    async startMonitoring() {
        try {
            console.log('🔄 Starting Twitter monitoring...');
            
            // Schedule periodic monitoring with rate limit awareness
            const monitorAccounts = async () => {
                try {
                    const accounts = await this.getMonitoredAccounts();
                    if (accounts.length === 0) {
                        return; // No accounts to monitor yet
                    }

                    // Process accounts in batches to respect rate limits
                    const BATCH_SIZE = 5;
                    for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
                        const batch = accounts.slice(i, i + BATCH_SIZE);
                        await this.batchProcessTweets(batch);
                    }
                } catch (error) {
                    if (error.code === 429) {
                        await this.handleRateLimit(error);
                    } else {
                        console.error('Error in monitor loop:', error);
                        await this.handleError(error);
                    }
                }
            };

            // Start the monitoring interval
            this.monitoringInterval = setInterval(monitorAccounts, this.config.monitoring.interval);
            console.log('✅ Twitter monitoring started');
        } catch (error) {
            console.error('Failed to start monitoring:', error);
            throw error;
        }
    }

    async batchProcessTweets(accounts) {
        try {
            for (const account of accounts) {
                await this.rateLimitManager.scheduleRequest(
                    async () => {
                        // Enhanced tweet lookup parameters
                        const tweets = await this.twitter.v2.userTimeline(account.id, {
                            max_results: account.lastTweetId ? 100 : 5, // 5 for first fetch, 100 for updates
                            since_id: account.lastTweetId || undefined,
                            tweet_fields: [
                                'created_at',
                                'entities',
                                'public_metrics',
                                'referenced_tweets',
                                'conversation_id'
                            ],
                            expansions: [
                                'author_id',
                                'referenced_tweets.id',
                                'referenced_tweets.id.author_id',
                                'in_reply_to_user_id',
                                'attachments.media_keys'
                            ],
                            user_fields: [
                                'name',
                                'username',
                                'profile_image_url'
                            ],
                            media_fields: [
                                'url',
                                'preview_image_url'
                            ]
                        });

                        if (!tweets.data?.length) {
                            return; // No new tweets
                        }

                        // Process tweets in chronological order
                        const sortedTweets = tweets.data.sort((a, b) => 
                            new Date(a.created_at) - new Date(b.created_at)
                        );

                        for (const tweet of sortedTweets) {
                            await this.processTweet(tweet, account, tweets.includes);
                        }

                        // Update last tweet ID with the most recent one
                        await this.updateLastTweetId(account.id, sortedTweets[sortedTweets.length - 1].id);
                    },
                    'users/:id/tweets'
                );
            }
        } catch (error) {
            console.error('[ERROR] Batch process tweets error:', error);
        }
    }



    async handleWalletMonitorCommand(interaction) {
        try {
            const address = interaction.options.getString('wallet');
            if (!address) {
                await interaction.reply({
                    content: 'Please provide a wallet address to monitor.',
                    ephemeral: true
                });
                return;
            }

            // Validate Solana address format
            if (!this.heliusService.isValidSolanaAddress(address)) {
                await interaction.reply({
                    content: 'Invalid Solana wallet address format.',
                    ephemeral: true
                });
                return;
            }

            // Add wallet to tracking
            const name = interaction.options.getString('name') || `Wallet-${address.slice(0, 4)}`;
            this.heliusService.setWalletName(address, name);

            await interaction.reply({
                content: `Now monitoring wallet ${name} (${address})`,
                ephemeral: true
            });

            // Update webhook with new wallet
            await this.setupHeliusWebhook();
        } catch (error) {
            console.error('[ERROR] Failed to handle wallet monitor command:', error);
            await interaction.reply({
                content: 'Failed to start monitoring wallet. Please try again later.',
                ephemeral: true
            });
        }
    }
}

module.exports = TwitterMonitorBot;