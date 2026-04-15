import axios, { AxiosRequestConfig } from 'axios'
import type { LogLevel } from './Logger'

const DISCORD_LIMIT = 2000

export interface DiscordConfig {
    enabled?: boolean
    url: string
}

let discordQueuePromise: Promise<any> | null = null

async function getDiscordQueue(): Promise<any> {
    if (!discordQueuePromise) {
        discordQueuePromise = import('p-queue').then(mod =>
            new mod.default({
                interval: 1000,
                intervalCap: 2,
                carryoverConcurrencyCount: true
            })
        )
    }

    return discordQueuePromise
}

function truncate(text: string) {
    return text.length <= DISCORD_LIMIT ? text : text.slice(0, DISCORD_LIMIT - 14) + ' …(truncated)'
}

export async function sendDiscord(discordUrl: string, content: string, level: LogLevel): Promise<void> {
    if (!discordUrl) return
    void level

    const request: AxiosRequestConfig = {
        method: 'POST',
        url: discordUrl,
        headers: { 'Content-Type': 'application/json' },
        data: { content: truncate(content), allowed_mentions: { parse: [] } },
        timeout: 10000
    }

    const discordQueue = await getDiscordQueue()
    await discordQueue.add(async () => {
        try {
            await axios(request)
        } catch (err: any) {
            const status = err?.response?.status
            if (status === 429) return
        }
    })
}

export async function flushDiscordQueue(timeoutMs = 5000): Promise<void> {
    const discordQueue = await getDiscordQueue()
    await Promise.race([
        (async () => {
            await discordQueue.onIdle()
        })(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('discord flush timeout')), timeoutMs))
    ]).catch(() => {})
}
