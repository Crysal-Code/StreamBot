import { Client } from "discord.js-selfbot-v13";
import { streamLivestreamVideo, MediaUdp, StreamOptions, Streamer, Utils } from "@dank074/discord-video-stream";
import config from "./config.js";
import fs from "fs";
import path from "path";
import logger from "./utils/logger.js";
import { getVideoParams } from "./utils/ffmpeg.js";
import PCancelable, { CancelError } from "p-cancelable";


// Create a new instance of Streamer
const streamer = new Streamer(new Client());

// Create a cancelable command
let command;

// Function to check if the channel is empty
async function isChannelEmpty(guildId, channelId) {
    const guild = streamer.client.guilds.cache.get(guildId) || await streamer.client.guilds.fetch(guildId);
    if (!guild) {
        logger.info("Guild not found");
        return true;
    }

    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId);
    if (!channel || !["GUILD_VOICE", "GUILD_STAGE_VOICE"].includes(channel.type)) {
        logger.info("Channel not found or not a voice channel");
        return true;
    }

    const voiceChannel = channel;
    const members = voiceChannel.members.filter(member => 
        !member.user.bot && member.id !== streamer.client.user.id // Exclude bots and the bot itself
    );

    logger.info(`Non-bot members in channel (excluding self): ${members.size}`);
    return members.size === 0;
}

// Function to get all video files from structured folders
function getAllVideoFiles(dir) {
    const videoFiles = [];

    function readDir(currentDir) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                // Recursively read subdirectories
                readDir(fullPath);
            } else if (entry.isFile() && /\.(mp4|mkv|avi|mov)$/i.test(entry.name)) {
                // Add video files (filter by extensions)
                const fileName = path.parse(entry.name).name;
                videoFiles.push({ name: fileName.replace(/ /g, "_"), path: fullPath });
            }
        }
    }

    readDir(dir);
    return videoFiles;
}

// Function to join the voice channel
async function joinVoiceChannel(guildId, channelId, streamOpts) {
    try {
        logger.info(`Attempting to fetch guild with ID: ${guildId}`);
        const guild = streamer.client.guilds.cache.get(guildId) || await streamer.client.guilds.fetch(guildId);
        if (!guild) {
            logger.error(`Guild not found. guildId=${guildId}`);
            return;
        }
        logger.info(`Fetched guild: ${guild.name} (ID: ${guildId})`);

        logger.info(`Attempting to fetch channel with ID: ${channelId}`);
        const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId);
        if (!channel) {
            logger.error(`Channel not found. channelId=${channelId}`);
            return;
        }
        logger.info(`Fetched channel: ${channel.name} (ID: ${channelId}, type: ${channel.type})`);

        if (!["GUILD_VOICE", "GUILD_STAGE_VOICE"].includes(channel.type)) {
            logger.error(`Channel is not a valid voice channel. channelId=${channelId}, channelType=${channel.type}`);
            return;
        }

        logger.info(`Checking permissions for channel: ${channel.name}`);
        if (!channel.permissionsFor(streamer.client.user)?.has(["VIEW_CHANNEL", "CONNECT", "SPEAK"])) {
            logger.error(`Missing permissions to join the channel. channelId=${channelId}`);
            return;
        }

        logger.info(`Joining voice channel: ${channel.name}`);
        await streamer.joinVoice(guildId, channelId, streamOpts);
        logger.info("Successfully joined the voice channel.");
    } catch (error) {
        logger.error(`Error joining voice channel: ${error.message}`);
    }
}

// Stream options
const streamOpts = {
    width: config.width,
    height: config.height,
    fps: config.fps,
    bitrateKbps: config.bitrateKbps,
    maxBitrateKbps: config.maxBitrateKbps,
    hardwareAcceleratedDecoding: config.hardwareAcceleratedDecoding,
    videoCodec: Utils.normalizeVideoCodec(config.videoCodec),
    rtcpSenderReportEnabled: true,
    readAtNativeFps: false,
    h26xPreset: config.h26xPreset
};

// Create the videosFolder dir
fs.mkdirSync(config.videosDir, { recursive: true });

// Get all video files from the directory and its subdirectories
const videos = getAllVideoFiles(config.videosDir);

logger.info(`Available videos (including structured folders):\n${videos.map(m => m.name).join("\n")}`);

// Ready event
// Ready event
streamer.client.on("ready", async () => {
    if (streamer.client.user) {
        logger.info(`${streamer.client.user.tag} is ready`);
        logger.info(`DEBUG: Guild ID: ${config.guildId}, Channel ID: ${config.videoChannelId}`);
        monitorVoiceChannel(); // Start monitoring the voice channel
    }
});


// Function to shuffle and play videos
async function shuffleAndPlayVideos(udpConn, guildId, channelId) {
    try {
        logger.info("shuffleAndPlayVideos: Function entered.");

        if (videos.length === 0) {
            logger.error("No videos to play.");
            return;
        }

        const shuffledVideos = [...videos];
        for (let i = shuffledVideos.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffledVideos[i], shuffledVideos[j]] = [shuffledVideos[j], shuffledVideos[i]];
        }

        for (const video of shuffledVideos) {
            // Check if the channel is empty before starting playback
            const channelIsEmpty = await isChannelEmpty(guildId, channelId);
            if (channelIsEmpty) {
                logger.info("Channel is empty before starting playback. Stopping and disconnecting.");
                await cleanupStreamStatus();
                return; // Exit the playback loop
            }

            logger.info(`Playing video: ${video.name}`);
            await playVideo(video.path, udpConn, video.name);

            // Check if the channel is empty after playback
            const channelIsEmptyAfterPlayback = await isChannelEmpty(guildId, channelId);
            if (channelIsEmptyAfterPlayback) {
                logger.info("Channel is empty after playback. Stopping and disconnecting.");
                await cleanupStreamStatus();
                return; // Exit the playback loop
            }

            if (command?.isCanceled) {
                logger.info("Playback canceled.");
                return;
            }
        }
    } catch (error) {
        logger.error("Error during shuffle playback:", error);
    }
}

// Function to play video
async function playVideo(video, udpConn, title) {
    logger.info(`Starting video: ${title}`);
    udpConn.mediaConnection.setSpeaking(true);
    udpConn.mediaConnection.setVideoStatus(true);

    try {
        command = PCancelable.fn(() => streamLivestreamVideo(video, udpConn))(video);
        await command;
        logger.info(`Finished playing video: ${title}`);
    } catch (error) {
        if (!(error instanceof CancelError)) {
            logger.error("Error during video playback:", error);
        }
    } finally {
        udpConn.mediaConnection.setSpeaking(false);
        udpConn.mediaConnection.setVideoStatus(false);
        logger.info("Playback completed.");
    }
}


// Cleanup function
async function cleanupStreamStatus() {
    await streamer.leaveVoice();
    logger.info("Left the voice channel and reset status.");
}

// Function to monitor the voice channel and shuffle play videos
async function monitorVoiceChannel() {
    const guildId = config.guildId;
    const channelId = config.videoChannelId;

    logger.info(`DEBUG: Using Guild ID: ${guildId}, Video Channel ID: ${channelId}`);

    while (true) {
        try {
            logger.info(`Checking voice channel status... Guild ID: ${guildId}, Channel ID: ${channelId}`);

            const channelIsEmpty = await isChannelEmpty(guildId, channelId);

            if (!channelIsEmpty) {
                logger.info("Users detected in the channel. Joining and starting playback.");

                await joinVoiceChannel(guildId, channelId, streamOpts);

                const udpConn = await streamer.createStream(streamOpts);
                if (udpConn) {
                    logger.info("Starting shuffle playback.");
                    await shuffleAndPlayVideos(udpConn, guildId, channelId);
                } else {
                    logger.error("Failed to create UDP connection. Retrying in 30 seconds.");
                }
            }
        } catch (error) {
            logger.error("Error in monitorVoiceChannel loop:", error);
        }

        // Check the channel status every 30 seconds
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}


// Login to Discord
streamer.client.login(config.token);

