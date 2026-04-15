import type { AxiosRequestConfig } from 'axios'
import type { Page } from 'patchright'
import * as fs from 'fs'
import path from 'path'

import { Workers } from '../../Workers'
import { QueryCore } from '../../QueryEngine'

import type { BasePromotion } from '../../../interface/DashboardData'
import { resolveGeminiApiKeys } from '../../../util/geminiApiKeys'

const geminiQueryCache = new Map<string, string[]>()

export class SearchOnBing extends Workers {
    private bingHome = 'https://bing.com'

    private cookieHeader: string = ''

    private fingerprintHeader: { [x: string]: string } = {}

    private gainedPoints: number = 0

    private success: boolean = false

    private oldBalance: number = this.bot.userData.currentPoints

    private apiKeys: string[]
    private currentKeyIndex: number = 0
    private geminiAI: any
    private geminiReady: Promise<void>

    constructor(bot: any) {
        super(bot)
        this.apiKeys = resolveGeminiApiKeys(this.bot.config)
        this.geminiReady = this.createGeminiClient(this.apiKeys[0] ?? '')
    }

    private async createGeminiClient(apiKey: string): Promise<void> {
        const mod = await import('@google/genai')
        this.geminiAI = new mod.GoogleGenAI({ apiKey })
    }

    private async ensureGeminiReady(): Promise<void> {
        await this.geminiReady
    }

    private async rotateApiKey(): Promise<void> {
        if (this.apiKeys.length === 0) {
            return
        }
        this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length
        const newKey = this.apiKeys[this.currentKeyIndex]!
        this.geminiReady = this.createGeminiClient(newKey)
        await this.geminiReady
        this.bot.logger.info(
            this.bot.isMobile,
            'SEARCH-ON-BING-GEMINI',
            `Rotated to API key ${this.currentKeyIndex + 1}/${this.apiKeys.length} | key=${newKey.substring(0, 20)}...`
        )
    }

    private isRateLimitError(error: any): boolean {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return errorMessage.toLowerCase().includes('rate limit') ||
               errorMessage.toLowerCase().includes('quota exceeded') ||
               errorMessage.toLowerCase().includes('too many requests') ||
               errorMessage.toLowerCase().includes('resource has been exhausted')
    }

    public async doSearchOnBing(promotion: BasePromotion, page: Page) {
        const offerId = promotion.offerId
        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)

        this.bot.logger.info(
            this.bot.isMobile,
            'SEARCH-ON-BING',
            `Starting SearchOnBing | offerId=${offerId} | title="${promotion.title}" | currentPoints=${this.oldBalance}`
        )

        try {
            this.cookieHeader = this.bot.browser.func.buildCookieHeader(
                this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop, [
                'bing.com',
                'live.com',
                'microsoftonline.com'
            ])

            const fingerprintHeaders = { ...this.bot.fingerprint.headers }
            delete fingerprintHeaders['Cookie']
            delete fingerprintHeaders['cookie']
            this.fingerprintHeader = fingerprintHeaders

            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-ON-BING',
                `Prepared headers for SearchOnBing | offerId=${offerId} | cookieLength=${this.cookieHeader.length} | fingerprintHeaderKeys=${Object.keys(this.fingerprintHeader).length}`
            )

            this.bot.logger.debug(this.bot.isMobile, 'SEARCH-ON-BING', `Activating search task | offerId=${offerId}`)

            const activated = await this.activateSearchTask(promotion)
            if (!activated) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'SEARCH-ON-BING',
                    `Search activity couldn't be activated, aborting | offerId=${offerId}`
                )
                return
            }

            // Check if activation already earned points (skip search if so)
            await this.bot.utils.wait(this.bot.utils.randomDelay(2000, 4000))
            const postActivationBalance = await this.bot.browser.func.getCurrentPoints()
            const activationGained = postActivationBalance - this.oldBalance

            if (activationGained > 0) {
                this.bot.userData.currentPoints = postActivationBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + activationGained
                this.success = true

                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING',
                    `Activity completed via activation, skipping search | offerId=${offerId} | gainedPoints=${activationGained} | newBalance=${postActivationBalance}`,
                    'green'
                )
                return
            }

            // Do the bing search here
            const queries = await this.getSearchQueries(promotion)

            // Run through the queries
            await this.searchBing(page, queries)

            if (this.success) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING',
                    `Completed SearchOnBing | offerId=${offerId} | startBalance=${this.oldBalance} | finalBalance=${this.bot.userData.currentPoints}`
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'SEARCH-ON-BING',
                    `Failed SearchOnBing | offerId=${offerId} | startBalance=${this.oldBalance} | finalBalance=${this.bot.userData.currentPoints}`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'SEARCH-ON-BING',
                `Error in doSearchOnBing | offerId=${promotion.offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async searchBing(page: Page, queries: string[]) {
        queries = [...new Set(queries)]

        this.bot.logger.debug(
            this.bot.isMobile,
            'SEARCH-ON-BING-SEARCH',
            `Starting search loop | queriesCount=${queries.length} | oldBalance=${this.oldBalance}`
        )

        let i = 0
        for (const query of queries) {
            try {
                this.bot.logger.debug(this.bot.isMobile, 'SEARCH-ON-BING-SEARCH', `Processing query | query="${query}"`)

                await this.bot.mainMobilePage.goto(this.bingHome)

                // Wait until page loaded
                await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})

                await this.bot.browser.utils.tryDismissAllMessages(page)

                const searchBar = '#sb_form_q'

                const searchBox = page.locator(searchBar)
                await searchBox.waitFor({ state: 'attached', timeout: 15000 })

                await this.bot.utils.wait(500)
                await this.bot.browser.utils.ghostClick(page, searchBar, { clickCount: 3 })
                await searchBox.fill('')

                await page.keyboard.type(query, { delay: 50 })
                await page.keyboard.press('Enter')

                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 7000))

                // Check for point updates
                const newBalance = await this.bot.browser.func.getCurrentPoints()
                this.gainedPoints = newBalance - this.oldBalance

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-SEARCH',
                    `Balance check after query | query="${query}" | oldBalance=${this.oldBalance} | newBalance=${newBalance} | gainedPoints=${this.gainedPoints}`
                )

                if (this.gainedPoints > 0) {
                    this.bot.userData.currentPoints = newBalance
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints

                    this.bot.logger.info(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-SEARCH',
                        `SearchOnBing query completed | query="${query}" | gainedPoints=${this.gainedPoints} | oldBalance=${this.oldBalance} | newBalance=${newBalance}`,
                        'green'
                    )

                    this.success = true
                    return
                } else {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-SEARCH',
                        `${++i}/${queries.length} | noPoints=1 | query="${query}"`
                    )
                }
            } catch (error) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-SEARCH',
                    `Error during search loop | query="${query}" | message=${error instanceof Error ? error.message : String(error)}`
                )
            } finally {
                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
                await page.goto(this.bot.config.baseURL, { timeout: 5000 }).catch(() => {})
            }
        }

        this.bot.logger.warn(
            this.bot.isMobile,
            'SEARCH-ON-BING-SEARCH',
            `Finished all queries with no points gained | queriesTried=${queries.length} | oldBalance=${this.oldBalance} | finalBalance=${this.bot.userData.currentPoints}`
        )
    }

    // The task needs to be activated before being able to complete it
    private async activateSearchTask(promotion: BasePromotion): Promise<boolean> {
        try {
            let success = false

            // Try primary method with RequestVerificationToken first
            if (this.bot.requestToken) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-ACTIVATE',
                    'Trying primary activation method with RequestVerificationToken'
                )

                const formData = new URLSearchParams({
                    id: promotion.offerId,
                    hash: promotion.hash,
                    timeZone: '60',
                    activityAmount: '1',
                    dbs: '0',
                    form: '',
                    type: '',
                    __RequestVerificationToken: this.bot.requestToken
                })

                const request: AxiosRequestConfig = {
                    url: 'https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest',
                    method: 'POST',
                    headers: {
                        ...(this.bot.fingerprint?.headers ?? {}),
                        Cookie: this.cookieHeader,
                        Referer: 'https://rewards.bing.com/',
                        Origin: 'https://rewards.bing.com'
                    },
                    data: formData
                }

                try {
                    const response = await this.bot.axios.request(request)
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-ACTIVATE',
                        `Successfully activated activity (primary method) | status=${response.status} | offerId=${promotion.offerId}`
                    )
                    success = true
                } catch (primaryError) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-ACTIVATE',
                        `Primary activation failed, trying dashboard fallback | error=${primaryError instanceof Error ? primaryError.message : String(primaryError)}`
                    )
                }
            }

            // If primary method failed or no token, try panel flyout reportactivity
            if (!success && this.bot.panelData) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-ACTIVATE',
                    `Trying panel flyout activation method | offerId=${promotion.offerId}`
                )

                try {
                    const todayKey = this.bot.utils.getFormattedDate()
                    const panelPromotion =
                        this.bot.panelData.flyoutResult?.morePromotions?.find(p => p.offerId === promotion.offerId) ||
                        this.bot.panelData.flyoutResult?.dailySetPromotions?.[todayKey]?.find(p => p.offerId === promotion.offerId)

                    if (panelPromotion) {
                        const jsonData = {
                            ActivityCount: 1,
                            ActivityType: panelPromotion.activityType,
                            ActivitySubType: '',
                            OfferId: promotion.offerId,
                            AuthKey: panelPromotion.hash,
                            Channel: this.bot.panelData.channel,
                            PartnerId: this.bot.panelData.partnerId,
                            UserId: this.bot.panelData.userId
                        }

                        const request: AxiosRequestConfig = {
                            url: 'https://www.bing.com/msrewards/api/v1/reportactivity',
                            method: 'POST',
                            headers: {
                                ...this.fingerprintHeader,
                                Cookie: this.cookieHeader,
                                Referer: 'https://www.bing.com/',
                                Origin: 'https://www.bing.com'
                            },
                            data: jsonData
                        }

                        const response = await this.bot.axios.request(request)
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'SEARCH-ON-BING-ACTIVATE',
                            `Successfully activated activity (panel flyout method) | status=${response.status} | offerId=${promotion.offerId}`
                        )
                        success = true
                    } else {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'SEARCH-ON-BING-ACTIVATE',
                            `Promotion not found in panel flyout data | offerId=${promotion.offerId}`
                        )
                    }
                } catch (panelError) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-ACTIVATE',
                        `Panel flyout activation failed | offerId=${promotion.offerId} | error=${panelError instanceof Error ? panelError.message : String(panelError)}`
                    )
                }
            }

            // If panel flyout also failed, try dashboard method
            if (!success) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-ACTIVATE',
                    `Using dashboard fallback method for activation | offerId=${promotion.offerId}`
                )

                await this.tryDashboardActivation(promotion)
                success = true // Assume success
            }

            return success

        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'SEARCH-ON-BING-ACTIVATE',
                `Activation failed | offerId=${promotion.offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    private async tryDashboardActivation(promotion: BasePromotion) {
        try {
            const offerId = promotion.offerId

            // Try to extract session ID and next-action hash from dashboard page
            const dashboardResponse = await this.bot.axios.request({
                url: 'https://rewards.bing.com/dashboard',
                method: 'GET',
                headers: {
                    ...(this.bot.fingerprint?.headers ?? {}),
                    Cookie: this.cookieHeader,
                    Referer: 'https://rewards.bing.com/',
                    Origin: 'https://rewards.bing.com'
                }
            })

            const html = typeof dashboardResponse.data === 'string' ? dashboardResponse.data : JSON.stringify(dashboardResponse.data)

            // Look for session ID (64 hex chars)
            const sessionIdMatch = html.match(/([a-f0-9]{64})/)
            const sessionId = sessionIdMatch ? sessionIdMatch[1] : null

            if (!sessionId) {
                throw new Error('Could not extract session ID from dashboard page')
            }

            // Look for next-action hash (40+ hex chars, typically in script tags or build manifest)
            const nextActionMatch = html.match(/\"([a-f0-9]{40,42})\"/)
            const nextAction = nextActionMatch ? nextActionMatch[1] : null

            this.bot.logger.info(
                this.bot.isMobile,
                'SEARCH-ON-BING-ACTIVATE',
                `Extracted dashboard data | sessionId=${sessionId.substring(0, 20)}... | nextAction=${nextAction ? nextAction.substring(0, 20) + '...' : 'none'}`
            )

            // Prepare dashboard payload
            const payload = [
                sessionId,
                11,
                {
                    offerid: offerId,
                    isPromotional: "$undefined",
                    timezoneOffset: "-480"
                }
            ]

            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-ON-BING-ACTIVATE',
                `Dashboard activation payload prepared | offerId=${offerId} | payload=${JSON.stringify(payload)}`
            )

            const headers: Record<string, string> = {
                ...(this.bot.fingerprint?.headers ?? {}),
                'Content-Type': 'text/plain;charset=UTF-8',
                'Accept': 'text/x-component',
                Cookie: this.cookieHeader,
                Referer: 'https://rewards.bing.com/dashboard',
                Origin: 'https://rewards.bing.com'
            }

            if (nextAction) {
                headers['next-action'] = nextAction
            }

            const request: AxiosRequestConfig = {
                url: 'https://rewards.bing.com/dashboard',
                method: 'POST',
                headers,
                data: JSON.stringify(payload)
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-ON-BING-ACTIVATE',
                `Sending dashboard activation request | offerId=${offerId} | url=${request.url}`
            )

            const response = await this.bot.axios.request(request)

            this.bot.logger.info(
                this.bot.isMobile,
                'SEARCH-ON-BING-ACTIVATE',
                `Dashboard activation completed | offerId=${offerId} | status=${response.status}`
            )

        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'SEARCH-ON-BING-ACTIVATE',
                `Dashboard activation failed | offerId=${promotion.offerId} | error=${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    private async generateGeminiQueries(activityTitle: string, activityDescription?: string): Promise<string[]> {
        const normalizedTitle = this.bot.utils.normalizeString(activityTitle)

        const cached = geminiQueryCache.get(normalizedTitle)
        if (cached) {
            this.bot.logger.info(
                this.bot.isMobile,
                'SEARCH-ON-BING-GEMINI',
                `Using cached Gemini queries for "${activityTitle}" | count=${cached.length} | first="${cached[0]}"`
            )
            return [...cached]
        }

        const extraGuidance =
            normalizedTitle === this.bot.utils.normalizeString('Lights, camera, action!')
                ? '\nFor this activity, the searches should be about movie casts (actors in a film).'
                : ''
        const descriptionLine = activityDescription?.trim()
            ? `\nActivity description: "${activityDescription.trim()}"`
            : ''

        const prompt = `You are an expert at creating realistic Bing search queries that would naturally complete Microsoft Rewards activities. Given the activity title: "${activityTitle}"${descriptionLine}${extraGuidance}

Generate a JSON array with exactly 5 unique, realistic search queries that would logically complete this activity. Each query should:

1. Be highly relevant to the activity title
2. Feel like something a real person would search for on Bing
3. Be 3-12 words long (natural search length)
4. Include variations that would trigger different search results
5. Use natural language patterns real people use

Examples for different activity types:
- "Quickly convert money" → ["usd to php conversion rate today", "convert 100 dollars to euros", "currency converter usd to gbp", "best currency exchange rates", "how to convert currency online"]
- "Find a recipe" → ["easy chicken stir fry recipe", "quick dinner ideas for 4 people", "healthy salad recipes", "vegetarian pasta recipes", "baking chocolate chip cookies"]
- "Weather forecast" → ["weather tomorrow in my area", "7 day weather forecast", "will it rain today", "temperature today", "weather radar near me"]

Output ONLY valid JSON array — nothing else — like this:
["query 1", "query 2", "query 3", "query 4", "query 5"]`

        let attempt = 0
        let consecutiveFailures = 0
        const maxConsecutiveFailures = 3 // Max failures per key before rotating

        while (true) {
            attempt++

            try {
                await this.ensureGeminiReady()
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-GEMINI',
                    `Generating queries for "${activityTitle}" (Attempt ${attempt}, Key ${this.currentKeyIndex + 1}/${this.apiKeys.length})`
                )

                const response = await this.geminiAI.models.generateContent({
                    model: "gemini-3-flash-preview",
                    contents: prompt,
                })

                if (!response.text) {
                    throw new Error('No text response from Gemini API')
                }

                const text = response.text

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-GEMINI',
                    `Gemini API response received | length=${text.length}`
                )

                // Parse the JSON response
                const queries = this.parseGeminiJsonResponse(text)

                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-GEMINI',
                    `✅ Generated ${queries.length} queries for "${activityTitle}" (attempt ${attempt}, key ${this.currentKeyIndex + 1}/${this.apiKeys.length}) | first="${queries[0]}"`
                )

                geminiQueryCache.set(normalizedTitle, queries)
                return queries

            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error)
                consecutiveFailures++

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-GEMINI',
                    `Attempt ${attempt} failed for "${activityTitle}" (Key ${this.currentKeyIndex + 1}/${this.apiKeys.length}): ${errorMessage}`
                )

                // Check if this is a rate limit error
                if (this.isRateLimitError(error)) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-GEMINI',
                        `Rate limit detected, rotating API key... (Consecutive failures: ${consecutiveFailures})`
                    )
                    await this.rotateApiKey()
                    consecutiveFailures = 0 // Reset consecutive failures for new key

                    // Brief wait before trying new key
                    await this.bot.utils.wait(1000)
                    continue
                }

                // For other errors, rotate key after max consecutive failures
                if (consecutiveFailures >= maxConsecutiveFailures) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-GEMINI',
                        `Too many consecutive failures (${consecutiveFailures}), rotating API key...`
                    )
                    await this.rotateApiKey()
                    consecutiveFailures = 0 // Reset for new key

                    // Brief wait before trying new key
                    await this.bot.utils.wait(1000)
                    continue
                }

                // Wait before retrying with same key
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-GEMINI',
                    `Waiting 30 seconds before retry ${attempt + 1}...`
                )
                await this.bot.utils.wait(30000)
            }
        }

        throw new Error('Unexpected error: Gemini API call did not complete after retries.')
    }

    private parseGeminiJsonResponse(response: string): string[] {
        try {
            // Clean the response by removing any markdown code blocks
            let cleanResponse = response.trim()

            // Remove markdown code blocks if present
            if (cleanResponse.startsWith('```json')) {
                cleanResponse = cleanResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '')
            } else if (cleanResponse.startsWith('```')) {
                cleanResponse = cleanResponse.replace(/^```\s*/, '').replace(/\s*```$/, '')
            }

            const parsed = JSON.parse(cleanResponse)

            if (!Array.isArray(parsed)) {
                throw new Error('Response is not an array')
            }

            // Validate that all items are strings and not empty
            const validQueries = parsed.filter((item: any) => typeof item === 'string' && item.trim().length > 0)

            if (validQueries.length === 0) {
                throw new Error('No valid queries found in response')
            }

            return validQueries.map((q: string) => q.trim())
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'SEARCH-ON-BING-GEMINI',
                `Failed to parse Gemini JSON response: ${error instanceof Error ? error.message : String(error)} | raw=${response.substring(0, 100)}...`
            )
            throw error
        }
    }

    private async getSearchQueries(promotion: BasePromotion): Promise<string[]> {
        interface Queries {
            title: string
            queries: string[]
        }

        let queries: Queries[] = []

        try {
            const configuredSources = this.bot.config.searchSettings.queryEngines ?? []
            const geminiOnly =
                configuredSources.length === 1 && configuredSources[0] === 'gemini'

            if (geminiOnly) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-QUERY',
                    `Gemini-only mode enabled, generating queries | title="${promotion.title}"`
                )

                try {
                    const geminiQueries = await this.generateGeminiQueries(promotion.title, promotion.description)
                    if (geminiQueries.length > 0) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'SEARCH-ON-BING-QUERY',
                            `Using Gemini-generated queries (gemini-only) | count=${geminiQueries.length} | title="${promotion.title}"`
                        )
                        return geminiQueries
                    }
                } catch (geminiError) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-QUERY',
                        `Gemini-only generation failed, falling back to configured sources | title="${promotion.title}" | error=${geminiError instanceof Error ? geminiError.message : String(geminiError)}`
                    )
                }
            }

            if (this.bot.config.searchOnBingLocalQueries) {
                this.bot.logger.debug(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', 'Using local queries config file')

                const data = fs.readFileSync(path.join(__dirname, '../bing-search-activity-queries.json'), 'utf8')
                queries = JSON.parse(data)

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-QUERY',
                    `Loaded queries config | source=local | entries=${queries.length}`
                )
            } else {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-QUERY',
                    'Fetching queries config from remote repository'
                )

                // Fetch from the repo directly so the user doesn't need to redownload the script for the new activities
                const response = await this.bot.axios.request({
                    method: 'GET',
                    url: 'https://raw.githubusercontent.com/TheNetsky/Microsoft-Rewards-Script/refs/heads/v3/src/functions/bing-search-activity-queries.json'
                })
                queries = response.data

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-QUERY',
                    `Loaded queries config | source=remote | entries=${queries.length}`
                )
            }

            const answers = queries.find(
                x => this.bot.utils.normalizeString(x.title) === this.bot.utils.normalizeString(promotion.title)
            )

            if (answers && answers.queries.length > 0) {
                const answer = this.bot.utils.shuffleArray(answers.queries)

                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-QUERY',
                    `Found answers for activity title | source=${this.bot.config.searchOnBingLocalQueries ? 'local' : 'remote'} | title="${promotion.title}" | answersCount=${answer.length} | firstQuery="${answer[0]}"`
                )

                return answer
            } else {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-QUERY',
                    `No matching title in queries config | source=${this.bot.config.searchOnBingLocalQueries ? 'local' : 'remote'} | title="${promotion.title}"`
                )

                const queryCore = new QueryCore(this.bot)

                const promotionDescription = promotion.description.toLowerCase().trim()
                const queryDescription = promotionDescription.replace('search on bing', '').trim()

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-QUERY',
                    `Requesting Bing suggestions | queryDescription="${queryDescription}"`
                )

                const bingSuggestions = await queryCore.getBingSuggestions(queryDescription)

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-QUERY',
                    `Bing suggestions result | count=${bingSuggestions.length} | title="${promotion.title}"`
                )

                // If no suggestions found, try Gemini AI to generate relevant queries
                if (!bingSuggestions.length) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-QUERY',
                        `No suggestions found, trying Gemini AI generation | title="${promotion.title}"`
                    )

                    try {
                        const geminiQueries = await this.generateGeminiQueries(promotion.title, promotion.description)
                        if (geminiQueries.length > 0) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'SEARCH-ON-BING-QUERY',
                                `Using Gemini-generated queries | count=${geminiQueries.length} | title="${promotion.title}"`
                            )
                            return geminiQueries
                        }
                    } catch (geminiError) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'SEARCH-ON-BING-QUERY',
                            `Gemini query generation failed, falling back to activity title | title="${promotion.title}" | error=${geminiError instanceof Error ? geminiError.message : String(geminiError)}`
                        )
                    }

                    // Final fallback to activity title
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-QUERY',
                        `Using activity title as final fallback | title="${promotion.title}"`
                    )
                    return [promotion.title]
                } else {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-QUERY',
                        `Using Bing suggestions as search queries | count=${bingSuggestions.length} | title="${promotion.title}"`
                    )
                    return bingSuggestions
                }
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'SEARCH-ON-BING-QUERY',
                `Error while resolving search queries | title="${promotion.title}" | message=${error instanceof Error ? error.message : String(error)} | fallback=promotionTitle`
            )
            return [promotion.title]
        }
    }
}
