import type { Page } from 'patchright'
import type { AxiosRequestConfig } from 'axios'
import type { MicrosoftRewardsBot } from '../index'
import type {
    DashboardData,
    PunchCard,
    BasePromotion,
    FindClippyPromotion,
    PurplePromotionalItem
} from '../interface/DashboardData'
import type { AppDashboardData } from '../interface/AppDashBoardData'

export class Workers {
    public bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    public async doDailySet(data: DashboardData, page: Page) {
        const todayKey = this.bot.utils.getFormattedDate()
        const todayData = data.dailySetPromotions[todayKey]

        const activitiesUncompleted = todayData?.filter(x => !x?.complete && x.pointProgressMax > 0) ?? []

        if (!activitiesUncompleted.length) {
            this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'All "Daily Set" items have already been completed')
            return
        }

        this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'Started solving "Daily Set" items')

        await this.solveActivities(activitiesUncompleted, page)

        this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'All "Daily Set" items have been completed')
    }

    public async doMorePromotions(data: DashboardData, page: Page) {
        const morePromotions: BasePromotion[] = [
            ...new Map(
                [...(data.morePromotions ?? []), ...(data.morePromotionsWithoutPromotionalItems ?? [])]
                    .filter(Boolean)
                    .map(p => [p.offerId, p as BasePromotion] as const)
            ).values()
        ]

        // Debug: log all promotions before filtering
        for (const p of morePromotions) {
            const type = p.promotionType || (p.attributes as any)?.type || 'none'
            const maxPoints = p?.pointProgressMax || Number((p.attributes as any)?.max) || 0
            this.bot.logger.info(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                `Raw promotion | offerId=${p.offerId} | complete=${p.complete} | type=${type} | promotionType=${p.promotionType} | pointProgressMax=${p.pointProgressMax} | attrMax=${(p.attributes as any)?.max} | maxPoints=${maxPoints} | locked=${p.exclusiveLockedFeatureStatus}`
            )
        }

        const activitiesUncompleted: BasePromotion[] =
            morePromotions?.filter(x => {
                if (x?.complete) return false
                const maxPoints = x?.pointProgressMax || Number((x.attributes as any)?.max) || 0
                if (maxPoints <= 0 && x.exclusiveLockedFeatureStatus !== 'notsupported') return false
                if (x.exclusiveLockedFeatureStatus === 'locked') return false

                const type = x.promotionType || (x.attributes as any)?.type
                if (!type) return false

                return true
            }) ?? []

        if (!activitiesUncompleted.length) {
            this.bot.logger.info(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                'All "More Promotion" items have already been completed'
            )
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'MORE-PROMOTIONS',
            `Started solving ${activitiesUncompleted.length} "More Promotions" items`
        )

        await this.solveActivities(activitiesUncompleted, page)

        this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', 'All "More Promotion" items have been completed')
    }

    public async doAppPromotions(data: AppDashboardData) {
        const appRewards = data.response.promotions.filter(x => {
            if (x.attributes['complete']?.toLowerCase() !== 'false') return false
            if (!x.attributes['offerid']) return false
            if (!x.attributes['type']) return false
            if (x.attributes['type'] !== 'sapphire') return false

            return true
        })

        if (!appRewards.length) {
            this.bot.logger.info(
                this.bot.isMobile,
                'APP-PROMOTIONS',
                'All "App Promotions" items have already been completed'
            )
            return
        }

        for (const reward of appRewards) {
            await this.bot.activities.doAppReward(reward)
            // A delay between completing each activity
            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
        }

        this.bot.logger.info(this.bot.isMobile, 'APP-PROMOTIONS', 'All "App Promotions" items have been completed')
    }

    public async doSpecialPromotions(data: DashboardData) {
        const specialPromotions: PurplePromotionalItem[] = [
            ...new Map(
                [...(data.promotionalItems ?? [])]
                    .filter(Boolean)
                    .map(p => [p.offerId, p as PurplePromotionalItem] as const)
            ).values()
        ]

        const supportedPromotions = ['ww_banner_optin_2x']

        const specialPromotionsUncompleted: PurplePromotionalItem[] =
            specialPromotions?.filter(x => {
                if (x?.complete) return false
                if (x?.exclusiveLockedFeatureStatus === 'locked') return false
                if (!x.promotionType) return false

                const offerId = (x.offerId ?? '').toLowerCase()
                return supportedPromotions.some(s => offerId.includes(s))
            }) ?? []

        for (const activity of specialPromotionsUncompleted) {
            try {
                const type = activity.promotionType?.toLowerCase() ?? ''
                const name = activity.name?.toLowerCase() ?? ''
                const offerId = (activity as PurplePromotionalItem).offerId

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SPECIAL-ACTIVITY',
                    `Processing activity | title="${activity.title}" | offerId=${offerId} | type=${type}"`
                )

                switch (type) {
                    // UrlReward
                    case 'urlreward': {
                        // Special "Double Search Points" activation
                        if (name.includes('ww_banner_optin_2x')) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Found activity type "Double Search Points" | title="${activity.title}" | offerId=${offerId}`
                            )

                            await this.bot.activities.doDoubleSearchPoints(activity)
                        }
                        break
                    }

                    // Unsupported types
                    default: {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'SPECIAL-ACTIVITY',
                            `Skipped activity "${activity.title}" | offerId=${offerId} | Reason: Unsupported type "${activity.promotionType}"`
                        )
                        break
                    }
                }
            } catch (error) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'SPECIAL-ACTIVITY',
                    `Error while solving activity "${activity.title}" | message=${error instanceof Error ? error.message : String(error)}`
                )
            }
        }

        this.bot.logger.info(this.bot.isMobile, 'SPECIAL-ACTIVITY', 'All "Special Activites" items have been completed')
    }

    public async doPunchCards(data: DashboardData, page: Page) {
        if (this.bot.rewardsVersion === 'modern') {
            const modernActivities = await this.getModernPunchCardActivitiesFromRsc()

            if (!modernActivities.length) {
                this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', 'No modern punchcard activities found in earn RSC')
                return
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'PUNCHCARD',
                `Started solving ${modernActivities.length} "Punch Card" items (modern RSC)`
            )

            await this.solveActivities(modernActivities, page)
            this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', 'All "Punch Card" items have been completed')
            return
        }

        const punchCards =
            data.punchCards?.filter(
                x => !x.parentPromotion?.complete && (x.parentPromotion?.pointProgressMax ?? 0) > 0
            ) ?? []

        const totalActivitiesUncompleted = punchCards.reduce((count, punchCard) => {
            const uncompleted =
                punchCard.childPromotions?.filter(x => {
                    if (x?.complete) return false
                    if (x?.exclusiveLockedFeatureStatus === 'locked') return false
                    if (!x.promotionType) return false

                    return true
                }) ?? []
            return count + uncompleted.length
        }, 0)

        if (!totalActivitiesUncompleted) {
            this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', 'All "Punch Card" items have already been completed')
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'PUNCHCARD',
            `Started solving ${totalActivitiesUncompleted} "Punch Card" items`
        )

        for (const punchCard of punchCards) {
            const activitiesUncompleted: BasePromotion[] =
                punchCard.childPromotions?.filter(x => {
                    if (x?.complete) return false
                    if (x?.exclusiveLockedFeatureStatus === 'locked') return false
                    if (!x.promotionType) return false

                    return true
                }) ?? []

            if (!activitiesUncompleted.length) {
                continue
            }

            await this.solveActivities(activitiesUncompleted, page, punchCard)
        }

        this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', 'All "Punch Card" items have been completed')
    }

    private buildQuestStateTree(questId: string): string {
        const tree = [
            '',
            {
                children: [
                    '(nav)',
                    {
                        children: [
                            'earn',
                            {
                                children: [
                                    'quest',
                                    {
                                        children: [
                                            ['questId', questId, 'd', null],
                                            { children: ['__PAGE__', {}, null, null, 0] },
                                            null,
                                            null,
                                            0
                                        ]
                                    },
                                    null,
                                    null,
                                    0
                                ]
                            },
                            null,
                            null,
                            0
                        ]
                    },
                    null,
                    null,
                    0
                ]
            },
            null,
            'refetch',
            16
        ]
        return encodeURIComponent(JSON.stringify(tree))
    }

    private async getModernPunchCardActivitiesFromRsc(): Promise<BasePromotion[]> {
        try {
            const cookieHeader = this.bot.browser.func.buildCookieHeader(
                this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop,
                ['bing.com', 'live.com', 'microsoftonline.com']
            )

            const earnRequest: AxiosRequestConfig = {
                url: 'https://rewards.bing.com/earn?_rsc=b1l97',
                method: 'GET',
                headers: {
                    ...(this.bot.fingerprint?.headers ?? {}),
                    accept: '*/*',
                    rsc: '1',
                    Cookie: cookieHeader,
                    Referer: 'https://rewards.bing.com/earn',
                    Origin: 'https://rewards.bing.com'
                }
            }

            const earnResponse = await this.bot.axios.request(earnRequest)
            const earnText =
                typeof earnResponse.data === 'string' ? earnResponse.data : JSON.stringify(earnResponse.data ?? {})

            const questIds: string[] = [
                ...new Set(
                    [...earnText.matchAll(/\/earn\/quest\/([^"\\?]+?pcparent[^"\\?]*)/gi)]
                        .map(m => m[1])
                        .filter((value): value is string => Boolean(value))
                )
            ]

            if (!questIds.length) {
                return []
            }

            const activities: BasePromotion[] = []
            const seenOfferIds = new Set<string>()

            for (const questId of questIds) {
                const stateTree = this.buildQuestStateTree(questId)
                const questRequest: AxiosRequestConfig = {
                    url: `https://rewards.bing.com/earn/quest/${questId}?_rsc=178ia`,
                    method: 'GET',
                    headers: {
                        ...(this.bot.fingerprint?.headers ?? {}),
                        accept: '*/*',
                        rsc: '1',
                        'next-router-state-tree': stateTree,
                        Cookie: cookieHeader,
                        Referer: `https://rewards.bing.com/earn/quest/${questId}`,
                        Origin: 'https://rewards.bing.com'
                    }
                }

                const questResponse = await this.bot.axios.request(questRequest)
                const questText =
                    typeof questResponse.data === 'string'
                        ? questResponse.data
                        : JSON.stringify(questResponse.data ?? {})

                const childOfferIds: string[] = [
                    ...new Set(
                        [...questText.matchAll(/"offerId":"([^"]*?_pcchild\d+_[^"]*)"/gi)]
                            .map(m => m[1])
                            .filter((value): value is string => Boolean(value))
                    )
                ]

                for (const offerId of childOfferIds) {
                    if (seenOfferIds.has(offerId)) continue
                    seenOfferIds.add(offerId)

                    activities.push({
                        offerId,
                        title: `Quest activity ${offerId}`,
                        name: offerId,
                        destinationUrl: `https://rewards.bing.com/earn/quest/${questId}`,
                        promotionType: 'urlreward',
                        complete: false,
                        exclusiveLockedFeatureStatus: 'unlocked',
                        attributes: {} as any
                    } as BasePromotion)
                }
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'PUNCHCARD',
                `Modern RSC punchcard detection | quests=${questIds.length} | activities=${activities.length}`
            )

            return activities
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'PUNCHCARD',
                `Failed to detect modern punchcards from RSC | message=${error instanceof Error ? error.message : String(error)}`
            )
            return []
        }
    }

    private shouldSkipTimeGatedPunchCardActivity(activity: BasePromotion, punchCard?: PunchCard): boolean {
        if (!punchCard) {
            return false
        }

        const descriptionText = [
            activity.title,
            activity.description,
            activity.linkText,
            punchCard.parentPromotion?.title,
            punchCard.parentPromotion?.description,
            String((activity.attributes as any)?.description ?? ''),
            String((activity.attributes as any)?.title ?? '')
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()

        const isTimeGated =
            /\b\d+\s*\/\s*\d+\s*days?\s*complete\b/i.test(descriptionText) ||
            /\b24\s*hours?\b/i.test(descriptionText)

        if (!isTimeGated) {
            return false
        }

        const progress = Number(activity.activityProgress ?? 0)
        const progressMax = Number(activity.activityProgressMax ?? 0)

        // If already partially progressed on a day-based quest, avoid retrying in the same run.
        return progress > 0 && progress < progressMax
    }

    private async solveActivities(activities: BasePromotion[], page: Page, punchCard?: PunchCard) {
        for (const activity of activities) {
            try {
                const type = (activity.promotionType || (activity.attributes as any)?.type || '').toLowerCase()
                const name = activity.name?.toLowerCase() ?? ''
                const offerId = (activity as BasePromotion).offerId
                const destinationUrl = activity.destinationUrl?.toLowerCase() ?? ''
                const isPunchCardChildOffer = /_pcchild\d+_/i.test(offerId)

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'ACTIVITY',
                    `Processing activity | title="${activity.title}" | offerId=${offerId} | type=${type} | punchCard="${punchCard?.parentPromotion?.title ?? 'none'}"`
                )

                if (this.shouldSkipTimeGatedPunchCardActivity(activity, punchCard)) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'ACTIVITY',
                        `Skipping time-gated punchcard activity for now | title="${activity.title}" | offerId=${offerId} | progress=${activity.activityProgress}/${activity.activityProgressMax}`
                    )
                    continue
                }

                switch (type) {
                    // Quiz-like activities (Poll / regular quiz variants)
                    case 'quiz': {
                        const basePromotion = activity as BasePromotion

                        // Poll (usually 10 points, pollscenarioid in URL)
                        if (activity.pointProgressMax === 10 && destinationUrl.includes('pollscenarioid')) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Found activity type "Poll" | title="${activity.title}" | offerId=${offerId}`
                            )

                            //await this.bot.activities.doPoll(basePromotion)
                            break
                        }

                        // All other quizzes handled via Quiz API
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'ACTIVITY',
                            `Found activity type "Quiz" | title="${activity.title}" | offerId=${offerId}`
                        )

                        await this.bot.activities.doQuiz(basePromotion)
                        break
                    }

                    // UrlReward
                    case 'urlreward': {
                        const basePromotion = activity as BasePromotion

                        // Search on Bing are subtypes of "urlreward"
                        const isExploreOnBing =
                            name.includes('exploreonbing') ||
                            (activity.attributes as any)?.isExploreOnBingTask === 'True' ||
                            destinationUrl.includes('search?q=')

                        if (isExploreOnBing) {
                            // First try to activate via reportactivity API (some exploreonbing tasks only need activation)
                            if (this.bot.requestToken && !isPunchCardChildOffer) {
                                this.bot.logger.info(
                                    this.bot.isMobile,
                                    'ACTIVITY',
                                    `Activating exploreonbing via reportactivity | title="${activity.title}" | offerId=${offerId}`
                                )

                                try {
                                    const cookieHeader = this.bot.browser.func.buildCookieHeader(
                                        this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop,
                                        ['bing.com', 'live.com', 'microsoftonline.com']
                                    )

                                    const formData = new URLSearchParams({
                                        id: offerId,
                                        hash: basePromotion.hash,
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
                                            Cookie: cookieHeader,
                                            Referer: 'https://rewards.bing.com/',
                                            Origin: 'https://rewards.bing.com'
                                        },
                                        data: formData
                                    }

                                    const response = await this.bot.axios.request(request)

                                    this.bot.logger.info(
                                        this.bot.isMobile,
                                        'ACTIVITY',
                                        `Activated exploreonbing via reportactivity | offerId=${offerId} | status=${response.status}`
                                    )

                                    // Check if points were earned from activation alone
                                    await this.bot.utils.wait(this.bot.utils.randomDelay(2000, 4000))
                                    const newBalance = await this.bot.browser.func.getCurrentPoints()
                                    const gained = newBalance - this.bot.userData.currentPoints

                                    if (gained > 0) {
                                        this.bot.userData.currentPoints = newBalance
                                        this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained

                                        this.bot.logger.info(
                                            this.bot.isMobile,
                                            'ACTIVITY',
                                            `Completed exploreonbing via activation | offerId=${offerId} | gainedPoints=${gained} | newBalance=${newBalance}`,
                                            'green'
                                        )
                                        break
                                    }
                                } catch (activationError) {
                                    this.bot.logger.warn(
                                        this.bot.isMobile,
                                        'ACTIVITY',
                                        `Activation via reportactivity failed for exploreonbing | offerId=${offerId} | error=${activationError instanceof Error ? activationError.message : String(activationError)}`
                                    )
                                }
                            }

                            // For punchcard child offers, use quest flow directly.
                            if (isPunchCardChildOffer) {
                                this.bot.logger.info(
                                    this.bot.isMobile,
                                    'ACTIVITY',
                                    `Trying quest flow for exploreonbing punchcard | title="${activity.title}" | offerId=${offerId}`
                                )

                                try {
                                    const balanceBefore = Number(this.bot.userData.currentPoints ?? 0)
                                    await this.bot.activities.doDaily(basePromotion)
                                    const balanceAfter = Number(this.bot.userData.currentPoints ?? balanceBefore)
                                    const gained = balanceAfter - balanceBefore

                                    if (gained > 0) {
                                        this.bot.logger.info(
                                            this.bot.isMobile,
                                            'ACTIVITY',
                                            `Completed exploreonbing via quest flow | offerId=${offerId} | gainedPoints=${gained}`,
                                            'green'
                                        )
                                        break
                                    }

                                    this.bot.logger.warn(
                                        this.bot.isMobile,
                                        'ACTIVITY',
                                        `Quest flow did not gain points for exploreonbing | offerId=${offerId} | oldBalance=${balanceBefore} | newBalance=${balanceAfter}`
                                    )
                                } catch (questError) {
                                    this.bot.logger.warn(
                                        this.bot.isMobile,
                                        'ACTIVITY',
                                        `Quest flow failed for exploreonbing | offerId=${offerId} | error=${questError instanceof Error ? questError.message : String(questError)}`
                                    )
                                }
                            }
                            // Try panel flyout method (works without requestToken)
                            else if (this.bot.panelData) {
                                this.bot.logger.info(
                                    this.bot.isMobile,
                                    'ACTIVITY',
                                    `Trying panel flyout for exploreonbing | title="${activity.title}" | offerId=${offerId}`
                                )

                                try {
                                    await this.bot.activities.doDaily(basePromotion)

                                    this.bot.logger.info(
                                        this.bot.isMobile,
                                        'ACTIVITY',
                                        `Completed exploreonbing via panel flyout | offerId=${offerId}`,
                                        'green'
                                    )
                                    break
                                } catch (panelError) {
                                    this.bot.logger.warn(
                                        this.bot.isMobile,
                                        'ACTIVITY',
                                        `Panel flyout failed for exploreonbing | offerId=${offerId} | error=${panelError instanceof Error ? panelError.message : String(panelError)}`
                                    )
                                }
                            }

                            // Fall back to SearchOnBing (search needed to complete the task)
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Found activity type "SearchOnBing" | title="${activity.title}" | offerId=${offerId}`
                            )

                            await this.bot.activities.doSearchOnBing(basePromotion, page)
                        } else {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Found activity type "UrlReward" | title="${activity.title}" | offerId=${offerId}`
                            )

                            const isPunchCardChildOffer = /_pcchild\d+_/i.test(offerId)
                            if (isPunchCardChildOffer) {
                                await this.bot.activities.doDaily(basePromotion)
                            } else if (this.bot.requestToken) {
                                await this.bot.activities.doUrlReward(basePromotion)
                            } else {
                                await this.bot.activities.doDaily(basePromotion)
                            }
                        }
                        break
                    }

                    // Find Clippy specific promotion type
                    case 'findclippy': {
                        const clippyPromotion = activity as unknown as FindClippyPromotion

                        this.bot.logger.info(
                            this.bot.isMobile,
                            'ACTIVITY',
                            `Found activity type "FindClippy" | title="${activity.title}" | offerId=${offerId}`
                        )

                        await this.bot.activities.doFindClippy(clippyPromotion)
                        break
                    }

                    // Unsupported types
                    default: {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'ACTIVITY',
                            `Skipped activity "${activity.title}" | offerId=${offerId} | Reason: Unsupported type "${activity.promotionType}"`
                        )
                        break
                    }
                }

                // Cooldown
                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
            } catch (error) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'ACTIVITY',
                    `Error while solving activity "${activity.title}" | message=${error instanceof Error ? error.message : String(error)}`
                )
            }
        }
    }
}
