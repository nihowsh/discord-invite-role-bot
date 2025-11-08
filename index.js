const { Client, GatewayIntentBits, Partials, PermissionFlagsBits, EmbedBuilder, SlashCommandBuilder, REST, Routes, Collection } = require('discord.js');
const express = require('express');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildInvites,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember]
});

const inviteCache = new Map();
const userInvites = new Map();
const spamTracker = new Map();

const OWNER_ROLE_NAME = 'Owner';
const MEMBER_ROLE_NAME = 'Member';
const REQUIRED_INVITES = 3;
const MIN_ACCOUNT_AGE_DAYS = 3;
const SPAM_MESSAGE_COUNT = 5;
const SPAM_TIME_WINDOW = 2000;
const HEARTBEAT_INTERVAL = 4 * 60 * 60 * 1000;
const BOT_LOGS_CHANNEL = 'bot-logs';

function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

function isOwner(member) {
    if (!member) return false;
    if (member.guild.ownerId === member.id) return true;
    return member.roles.cache.some(role => role.name === OWNER_ROLE_NAME);
}

function getAccountAgeDays(user) {
    const now = Date.now();
    const created = user.createdTimestamp;
    return (now - created) / (1000 * 60 * 60 * 24);
}

async function loadInvites(guild) {
    try {
        const invites = await guild.invites.fetch();
        inviteCache.set(guild.id, new Map(invites.map(inv => [inv.code, inv.uses])));
        log(`✅ Loaded ${invites.size} invites for guild: ${guild.name}`);
    } catch (error) {
        log(`⚠️ Could not load invites for ${guild.name}: ${error.message}`);
    }
}

client.once('ready', async () => {
    log(`🤖 Bot logged in as ${client.user.tag}`);
    
    for (const guild of client.guilds.cache.values()) {
        await loadInvites(guild);
    }

    const commands = [
        new SlashCommandBuilder()
            .setName('massdm')
            .setDescription('Send a DM to all server members (Owner only)')
            .addStringOption(option =>
                option.setName('message')
                    .setDescription('The message to send')
                    .setRequired(true))
            .addAttachmentOption(option =>
                option.setName('attachment')
                    .setDescription('Optional image/video/file to send')
                    .setRequired(false))
    ].map(command => command.toJSON());

    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
        
        for (const guild of client.guilds.cache.values()) {
            await rest.put(
                Routes.applicationGuildCommands(client.user.id, guild.id),
                { body: commands }
            );
            log(`✅ Registered slash commands for guild: ${guild.name}`);
        }
    } catch (error) {
        log(`⚠️ Error registering commands: ${error.message}`);
    }

    startHeartbeat();
    log('🚀 Bot is fully operational!');
});

client.on('guildCreate', async (guild) => {
    await loadInvites(guild);
    log(`➕ Bot joined new guild: ${guild.name}`);
});

client.on('inviteCreate', async (invite) => {
    const guildInvites = inviteCache.get(invite.guild.id) || new Map();
    guildInvites.set(invite.code, invite.uses || 0);
    inviteCache.set(invite.guild.id, guildInvites);
    log(`🔗 New invite created: ${invite.code}`);
});

client.on('inviteDelete', async (invite) => {
    const guildInvites = inviteCache.get(invite.guild.id);
    if (guildInvites) {
        guildInvites.delete(invite.code);
        log(`🗑️ Invite deleted: ${invite.code}`);
    }
});

client.on('guildMemberAdd', async (member) => {
    try {
        const guild = member.guild;
        log(`👤 ${member.user.tag} joined ${guild.name}`);

        const newInvites = await guild.invites.fetch();
        const oldInvites = inviteCache.get(guild.id) || new Map();

        let usedInvite = null;
        let inviter = null;

        for (const [code, newUses] of newInvites.map(inv => [inv.code, inv.uses])) {
            const oldUses = oldInvites.get(code) || 0;
            if (newUses > oldUses) {
                usedInvite = newInvites.get(code);
                inviter = usedInvite.inviter;
                break;
            }
        }

        inviteCache.set(guild.id, new Map(newInvites.map(inv => [inv.code, inv.uses])));

        if (inviter) {
            const accountAge = getAccountAgeDays(member.user);
            
            if (accountAge < MIN_ACCOUNT_AGE_DAYS) {
                log(`🚫 Anti-Alt: Ignored invite from ${member.user.tag} (account age: ${accountAge.toFixed(1)} days)`);
                return;
            }

            const inviterKey = `${guild.id}-${inviter.id}`;
            const currentInvites = userInvites.get(inviterKey) || 0;
            const newInviteCount = currentInvites + 1;
            userInvites.set(inviterKey, newInviteCount);

            log(`📊 ${inviter.tag} now has ${newInviteCount} valid invites`);

            if (newInviteCount >= REQUIRED_INVITES) {
                const inviterMember = await guild.members.fetch(inviter.id).catch(() => null);
                if (inviterMember) {
                    const memberRole = guild.roles.cache.find(role => role.name === MEMBER_ROLE_NAME);
                    if (memberRole) {
                        if (!inviterMember.roles.cache.has(memberRole.id)) {
                            await inviterMember.roles.add(memberRole);
                            log(`🎟️ Auto-Role: Granted "${MEMBER_ROLE_NAME}" role to ${inviter.tag} (${newInviteCount} invites)`);
                        }
                    } else {
                        log(`⚠️ Role "${MEMBER_ROLE_NAME}" not found in guild: ${guild.name}`);
                    }
                }
            }
        } else {
            log(`⚠️ Could not determine invite used by ${member.user.tag}`);
        }
    } catch (error) {
        log(`❌ Error in guildMemberAdd: ${error.message}`);
    }
});

client.on('messageCreate', async (message) => {
    try {
        if (message.author.bot) return;
        if (!message.guild) return;

        const member = message.member;
        if (isOwner(member)) {
            return;
        }

        const userId = message.author.id;
        const now = Date.now();

        if (!spamTracker.has(userId)) {
            spamTracker.set(userId, []);
        }
        const userMessages = spamTracker.get(userId);
        userMessages.push(now);

        const recentMessages = userMessages.filter(timestamp => now - timestamp < SPAM_TIME_WINDOW);
        spamTracker.set(userId, recentMessages);

        if (recentMessages.length >= SPAM_MESSAGE_COUNT) {
            await message.delete().catch(() => {});
            log(`💨 Anti-Spam: Deleted message from ${message.author.tag} (${recentMessages.length} messages in ${SPAM_TIME_WINDOW / 1000}s)`);
            spamTracker.set(userId, []);
            return;
        }

        if (message.content.includes('@everyone') || message.content.includes('@here')) {
            if (!message.member.permissions.has(PermissionFlagsBits.MentionEveryone)) {
                await message.delete().catch(() => {});
                log(`🚫 @everyone Protection: Deleted message from ${message.author.tag}`);
                return;
            }
        }

        const linkPatterns = [
            /discord\.gg\/[\w-]+/gi,
            /discord\.com\/invite\/[\w-]+/gi,
            /discordapp\.com\/invite\/[\w-]+/gi,
            /(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/[\w\-\?=&]+/gi,
            /(https?:\/\/)?(open\.)?spotify\.com\/[\w\-\?=&\/]+/gi
        ];

        for (const pattern of linkPatterns) {
            if (pattern.test(message.content)) {
                await message.delete().catch(() => {});
                log(`🔗 Link Blocker: Deleted message from ${message.author.tag} (contained blocked link)`);
                return;
            }
        }

    } catch (error) {
        log(`❌ Error in messageCreate: ${error.message}`);
    }
});

client.on('interactionCreate', async (interaction) => {
    try {
        if (!interaction.isCommand()) return;

        if (interaction.commandName === 'massdm') {
            if (!isOwner(interaction.member)) {
                await interaction.reply({ content: '❌ Only users with the Owner role can use this command!', ephemeral: true });
                return;
            }

            await interaction.deferReply({ ephemeral: true });

            const message = interaction.options.getString('message');
            const attachment = interaction.options.getAttachment('attachment');

            const members = await interaction.guild.members.fetch();
            const realMembers = members.filter(member => !member.user.bot);

            let successCount = 0;
            let failCount = 0;

            log(`💬 Mass DM initiated by ${interaction.user.tag} to ${realMembers.size} members`);

            for (const [id, member] of realMembers) {
                try {
                    const dmOptions = { content: message };
                    if (attachment) {
                        dmOptions.files = [attachment.url];
                    }
                    await member.send(dmOptions);
                    successCount++;
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (error) {
                    failCount++;
                }
            }

            await interaction.editReply(`✅ Mass DM complete!\n📤 Successfully sent: ${successCount}\n❌ Failed: ${failCount}`);
            log(`💬 Mass DM complete: ${successCount} sent, ${failCount} failed`);
        }
    } catch (error) {
        log(`❌ Error in interactionCreate: ${error.message}`);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply('❌ An error occurred while processing the command.').catch(() => {});
        } else {
            await interaction.reply({ content: '❌ An error occurred while processing the command.', ephemeral: true }).catch(() => {});
        }
    }
});

function startHeartbeat() {
    setInterval(async () => {
        try {
            for (const guild of client.guilds.cache.values()) {
                const channel = guild.channels.cache.find(ch => ch.name === BOT_LOGS_CHANNEL);
                if (channel && channel.isTextBased()) {
                    await channel.send('❤️ Still alive');
                    log(`❤️ Heartbeat sent to ${guild.name}/#${BOT_LOGS_CHANNEL}`);
                }
            }
        } catch (error) {
            log(`⚠️ Heartbeat error: ${error.message}`);
        }
    }, HEARTBEAT_INTERVAL);
}

const app = express();
const PORT = 3000;

app.get('/', (req, res) => {
    res.send('🤖 Discord Bot is running!');
});

app.get('/ping', (req, res) => {
    res.json({ status: 'alive', uptime: process.uptime() });
});

app.listen(PORT, '0.0.0.0', () => {
    log(`🌐 Keep-Alive server running on port ${PORT}`);
});

process.on('unhandledRejection', (error) => {
    log(`❌ Unhandled Rejection: ${error.message}`);
});

process.on('uncaughtException', (error) => {
    log(`❌ Uncaught Exception: ${error.message}`);
});

if (!process.env.DISCORD_BOT_TOKEN) {
    log('❌ DISCORD_BOT_TOKEN is not set! Please add it to your environment variables.');
    process.exit(1);
}

client.login(process.env.DISCORD_BOT_TOKEN).catch(error => {
    log(`❌ Failed to login: ${error.message}`);
    process.exit(1);
});

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('🤖 Bot is alive!'));
app.listen(PORT, () => console.log(`🌐 Keep-alive server running on port ${PORT}`));
