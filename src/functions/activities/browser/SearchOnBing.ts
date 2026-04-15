import type { Page } from 'patchright'
import * as fs from 'fs'
import path from 'path'

import { Workers } from '../../Workers'
import { QueryCore } from '../../QueryEngine'

import type { BasePromotion } from '../../../interface/DashboardData'

export class SearchOnBing extends Workers {
    private bingHome = 'https://bing.com'

    private cookieHeader: string = ''

    private fingerprintHeader: { [x: string]: string } = {}

    private gainedPoints: number = 0

    private success: boolean = false

    private oldBalance: number = this.bot.userData.currentPoints

    constructor(bot: any) {
        super(bot)
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

            const pointProgress = Number(promotion.pointProgress ?? 0)
            const pointProgressMax = Number(promotion.pointProgressMax ?? 0)
            if (pointProgressMax > 0 && pointProgress >= pointProgressMax) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING',
                    `Search activity already complete by progress | offerId=${offerId} | progress=${pointProgress}/${pointProgressMax}`
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

    private async getSearchQueries(promotion: BasePromotion): Promise<string[]> {
        interface Queries {
            title: string
            queries: string[]
        }

        let queries: Queries[] = []
        const queryCore = new QueryCore(this.bot)
        const locale = (this.bot.userData.geoLocale ?? 'US').toUpperCase()
        const langCode = (this.bot.userData.langCode ?? 'en').toLowerCase()
        const configuredSources = this.bot.config.searchSettings.queryEngines ?? []
        const sourceOrder = (['gemini', ...configuredSources] as const).filter(
            (source, index, arr) => arr.indexOf(source) === index
        ) as ('gemini' | 'google' | 'wikipedia' | 'reddit' | 'local')[]

        try {
            const geminiOnly =
                configuredSources.length === 1 && configuredSources[0] === 'gemini'

            if (geminiOnly) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-QUERY',
                    `Gemini-only mode enabled, generating queries via QueryCore | title="${promotion.title}"`
                )

                try {
                    const mainQueries = await queryCore.queryManager({
                        shuffle: true,
                        related: false,
                        langCode,
                        geoLocale: locale,
                        sourceOrder
                    })
                    if (mainQueries.length > 0) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'SEARCH-ON-BING-QUERY',
                            `Using QueryCore-generated queries (gemini-only) | count=${mainQueries.length} | title="${promotion.title}"`
                        )
                        return mainQueries
                    }
                } catch (queryError) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-QUERY',
                        `Gemini-only QueryCore generation failed, falling back to configured sources | title="${promotion.title}" | error=${queryError instanceof Error ? queryError.message : String(queryError)}`
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

                // If no suggestions found, use the main QueryCore generation flow.
                if (!bingSuggestions.length) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-QUERY',
                        `No suggestions found, generating via QueryCore main flow | title="${promotion.title}"`
                    )

                    try {
                        const mainQueries = await queryCore.queryManager({
                            shuffle: true,
                            related: false,
                            langCode,
                            geoLocale: locale,
                            sourceOrder
                        })
                        if (mainQueries.length > 0) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'SEARCH-ON-BING-QUERY',
                                `Using QueryCore-generated queries | count=${mainQueries.length} | title="${promotion.title}"`
                            )
                            return mainQueries
                        }
                    } catch (queryError) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'SEARCH-ON-BING-QUERY',
                            `QueryCore generation failed, falling back to activity title | title="${promotion.title}" | error=${queryError instanceof Error ? queryError.message : String(queryError)}`
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
