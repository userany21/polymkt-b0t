import { Client, GatewayIntentBits, Message, TextChannel } from 'discord.js';
import { spawn, ChildProcess } from 'child_process';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const COMMAND_CHANNEL_ID = process.env.COMMAND_CHANNEL_ID;

if (!BOT_TOKEN || !COMMAND_CHANNEL_ID) {
    console.error('Missing DISCORD_BOT_TOKEN or COMMAND_CHANNEL_ID in .env');
    process.exit(1);
}

const ROOT = path.resolve(__dirname, '../../');

const ALLOWED_COMMANDS: Record<string, { cmd: string; args: string[] }> = {
    'npm start':              { cmd: 'npm', args: ['start'] },
    'npm run check-stats':    { cmd: 'npm', args: ['run', 'check-stats'] },
    'npm run check-allowance':{ cmd: 'npm', args: ['run', 'check-allowance'] },
    'npm run redeem-resolved':{ cmd: 'npm', args: ['run', 'redeem-resolved'] },
    'npm run health-check':   { cmd: 'npm', args: ['run', 'health-check'] },
    'npm run sell-large':     { cmd: 'npm', args: ['run', 'sell-large'] },
};

const HELP_TEXT = [
    '**Available commands:**',
    '`npm start` — start the trading bot',
    '`stop` — stop the currently running process (Ctrl+C)',
    '`npm run check-stats` — check your stats',
    '`npm run check-allowance` — check token allowance',
    '`npm run redeem-resolved` — redeem resolved positions',
    '`npm run health-check` — run health check',
    '`npm run sell-large` — sell large positions',
    '`help` — show this message',
].join('\n');

let activeProcess: ChildProcess | null = null;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.once('ready', () => {
    console.log(`Discord bot ready — logged in as ${client.user?.tag}`);
});

async function sendChunked(channel: TextChannel, text: string): Promise<void> {
    const MAX = 1900;
    const trimmed = text.trim();
    if (!trimmed) return;
    for (let i = 0; i < trimmed.length; i += MAX) {
        await channel.send('```\n' + trimmed.slice(i, i + MAX) + '\n```');
    }
}

client.on('messageCreate', async (message: Message) => {
    if (message.channelId !== COMMAND_CHANNEL_ID) return;
    if (message.author.bot) return;

    const content = message.content.trim();
    const channel = message.channel as TextChannel;

    if (content === 'help') {
        await channel.send(HELP_TEXT);
        return;
    }

    if (content === 'stop') {
        if (activeProcess) {
            activeProcess.kill('SIGINT');
            activeProcess = null;
            await channel.send('Process stopped.');
        } else {
            await channel.send('No process is currently running.');
        }
        return;
    }

    if (content === 'status') {
        await channel.send(activeProcess ? 'A process is currently running.' : 'No process running.');
        return;
    }

    const command = ALLOWED_COMMANDS[content];
    if (!command) {
        await channel.send(`Unknown command. Type \`help\` to see available commands.`);
        return;
    }

    if (activeProcess) {
        await channel.send('A process is already running. Type `stop` to stop it first.');
        return;
    }

    await channel.send(`Running: \`${content}\``);

    const proc = spawn(command.cmd, command.args, {
        cwd: ROOT,
        shell: false,
    });

    activeProcess = proc;

    let buffer = '';

    const flush = async () => {
        if (buffer.trim()) {
            await sendChunked(channel, buffer);
            buffer = '';
        }
    };

    proc.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
        buffer += data.toString();
    });

    const flushInterval = setInterval(async () => {
        await flush();
    }, 3000);

    proc.on('close', async (code: number | null) => {
        clearInterval(flushInterval);
        await flush();
        await channel.send(`Process exited with code **${code ?? 'unknown'}**`);
        activeProcess = null;
    });

    proc.on('error', async (err: Error) => {
        clearInterval(flushInterval);
        await channel.send(`Error starting process: ${err.message}`);
        activeProcess = null;
    });
});

client.login(BOT_TOKEN);
