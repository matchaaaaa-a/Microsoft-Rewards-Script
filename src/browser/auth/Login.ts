import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../index'
import { saveSessionData } from '../../util/Load'

import { MobileAccessLogin } from './methods/MobileAccessLogin'
import { EmailLogin } from './methods/EmailLogin'
import { PasswordlessLogin } from './methods/PasswordlessLogin'
import { TotpLogin } from './methods/Totp2FALogin'
import { CodeLogin } from './methods/GetACodeLogin'
import { RecoveryLogin } from './methods/RecoveryEmailLogin'

import type { Account } from '../../interface/Account'

type LoginState =
    | 'EMAIL_INPUT'
    | 'PASSWORD_INPUT'
    | 'SIGN_IN_ANOTHER_WAY'
    | 'SIGN_IN_ANOTHER_WAY_EMAIL'
    | 'PASSKEY_ERROR'
    | 'PASSKEY_VIDEO'
    | 'KMSI_PROMPT'
    | 'LOGGED_IN'
    | 'RECOVERY_EMAIL_INPUT'
    | 'ACCOUNT_LOCKED'
    | 'ERROR_ALERT'
    | '2FA_TOTP'
    | 'LOGIN_PASSWORDLESS'
    | 'GET_A_CODE'
    | 'GET_A_CODE_2'
    | 'UNKNOWN'
    | 'CHROMEWEBDATA_ERROR'

export class Login {
    emailLogin: EmailLogin
    passwordlessLogin: PasswordlessLogin
    totp2FALogin: TotpLogin
    codeLogin: CodeLogin
    recoveryLogin: RecoveryLogin

    private readonly selectors = {
        primaryButton: 'button[data-testid="primaryButton"]',
        secondaryButton: 'button[data-testid="secondaryButton"]',
        emailIcon: '[data-testid="tile"]:has(svg path[d*="M5.25 4h13.5a3.25"])',
        emailIconOld: 'img[data-testid="accessibleImg"][src*="picker_verify_email"]',
        recoveryEmail: '[data-testid="proof-confirmation"]',
        passwordIcon: '[data-testid="tile"]:has(svg path[d*="M11.78 10.22a.75.75"])',
        accountLocked: '#serviceAbuseLandingTitle',
        errorAlert: 'div[role="alert"]',
        passwordEntry: '[data-testid="passwordEntry"]',
        emailEntry: 'input#usernameEntry',
        kmsiVideo: '[data-testid="kmsiVideo"]',
        passKeyVideo: '[data-testid="biometricVideo"]',
        passKeyError: '[data-testid="registrationImg"]',
        passwordlessCheck: '[data-testid="deviceShieldCheckmarkVideo"]',
        totpInput: 'input[name="otc"]',
        totpInputOld: 'form[name="OneTimeCodeViewForm"]',
        identityBanner: '[data-testid="identityBanner"]',
        viewFooter: '[data-testid="viewFooter"] >> [role="button"]',
        bingProfile: '#id_n',
        requestToken: 'input[name="__RequestVerificationToken"]',
        requestTokenMeta: 'meta[name="__RequestVerificationToken"]'
    } as const

    constructor(private bot: MicrosoftRewardsBot) {
        this.emailLogin = new EmailLogin(this.bot)
        this.passwordlessLogin = new PasswordlessLogin(this.bot)
        this.totp2FALogin = new TotpLogin(this.bot)
        this.codeLogin = new CodeLogin(this.bot)
        this.recoveryLogin = new RecoveryLogin(this.bot)
    }

    async login(page: Page, account: Account) {
        try {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Starting login process')

            await page
                .goto('https://rewards.bing.com/createuser?idru=%2F&userScenarioId=anonsignin', {
                    waitUntil: 'domcontentloaded'
                })
                .catch(() => {})
            await this.bot.browser.utils.reloadBadPage(page)
            await this.bot.browser.utils.disableFido(page)

            const maxIterations = 25
            let iteration = 0
            let previousState: LoginState = 'UNKNOWN'
            let sameStateCount = 0

            while (iteration < maxIterations) {
                if (page.isClosed()) throw new Error('Page closed unexpectedly')

                iteration++
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `State check iteration ${iteration}/${maxIterations}`)

                const state = await this.detectCurrentState(page, account)
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `Current state: ${state}`)

                if (state !== previousState && previousState !== 'UNKNOWN') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', `State transition: ${previousState} → ${state}`)
                }

                if (state === previousState && state !== 'LOGGED_IN' && state !== 'UNKNOWN') {
                    sameStateCount++
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'LOGIN',
                        `Same state count: ${sameStateCount}/4 for state "${state}"`
                    )
                    if (sameStateCount >= 4) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'LOGIN',
                            `Stuck in state "${state}" for 4 loops, refreshing page`
                        )
                        await page.reload({ waitUntil: 'domcontentloaded' })
                        sameStateCount = 0
                        previousState = 'UNKNOWN'
                        continue
                    }
                } else {
                    sameStateCount = 0
                }
                previousState = state

                if (state === 'LOGGED_IN') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Successfully logged in')
                    break
                }

                const shouldContinue = await this.handleState(state, page, account)
                if (!shouldContinue) {
                    throw new Error(`Login failed or aborted at state: ${state}`)
                }
            }

            if (iteration >= maxIterations) {
                throw new Error('Login timeout: exceeded maximum iterations')
            }

            await this.finalizeLogin(page, account.email)
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN',
                `Fatal error: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    private async detectCurrentState(page: Page, account?: Account): Promise<LoginState> {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

        const url = new URL(page.url())
        this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `Current URL: ${url.hostname}${url.pathname}`)

        if (url.hostname === 'chromewebdata') {
            this.bot.logger.warn(this.bot.isMobile, 'DETECT-STATE', 'Detected chromewebdata error page')
            return 'CHROMEWEBDATA_ERROR'
        }

        // Check for passkey interrupt URL FIRST
        if (url.hostname === 'account.live.com' && url.pathname === '/interrupt/passkey/enroll') {
            this.bot.logger.info(this.bot.isMobile, 'DETECT-STATE', 'Passkey interrupt URL detected')
            return 'PASSKEY_ERROR'
        }

        const isLocked = await this.checkSelector(page, this.selectors.accountLocked)
        if (isLocked) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', 'Account locked selector found')
            return 'ACCOUNT_LOCKED'
        }

        if (url.hostname === 'rewards.bing.com' || url.hostname === 'account.microsoft.com') {
            const isSuspended = await this.checkForSuspension(page)
            if (isSuspended) {
                this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', 'Account suspension detected on rewards page')
                return 'ACCOUNT_LOCKED'
            }
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', 'On rewards/account page, assuming logged in')
            return 'LOGGED_IN'
        }

        const stateChecks: Array<[string, LoginState]> = [
            [this.selectors.errorAlert, 'ERROR_ALERT'],
            [this.selectors.passwordEntry, 'PASSWORD_INPUT'],
            [this.selectors.emailEntry, 'EMAIL_INPUT'],
            [this.selectors.recoveryEmail, 'RECOVERY_EMAIL_INPUT'],
            [this.selectors.kmsiVideo, 'KMSI_PROMPT'],
            [this.selectors.passKeyVideo, 'PASSKEY_VIDEO'],
            [this.selectors.passKeyError, 'PASSKEY_ERROR'],
            [this.selectors.passwordIcon, 'SIGN_IN_ANOTHER_WAY'],
            [this.selectors.emailIcon, 'SIGN_IN_ANOTHER_WAY_EMAIL'],
            [this.selectors.emailIconOld, 'SIGN_IN_ANOTHER_WAY_EMAIL'],
            [this.selectors.passwordlessCheck, 'LOGIN_PASSWORDLESS'],
            [this.selectors.totpInput, '2FA_TOTP'],
            [this.selectors.totpInputOld, '2FA_TOTP']
        ]

        const results = await Promise.all(
            stateChecks.map(async ([sel, state]) => {
                const visible = await this.checkSelector(page, sel)
                return visible ? state : null
            })
        )

        const visibleStates = results.filter((s): s is LoginState => s !== null)
        if (visibleStates.length > 0) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `Visible states: [${visibleStates.join(', ')}]`)
        }

        const [identityBanner, primaryButton, passwordEntry] = await Promise.all([
            this.checkSelector(page, this.selectors.identityBanner),
            this.checkSelector(page, this.selectors.primaryButton),
            this.checkSelector(page, this.selectors.passwordEntry)
        ])

        if (identityBanner && primaryButton && !passwordEntry && !results.includes('2FA_TOTP')) {
            const codeState = account?.password ? 'GET_A_CODE' : 'GET_A_CODE_2'
            this.bot.logger.debug(
                this.bot.isMobile,
                'DETECT-STATE',
                `Get code state detected: ${codeState} (has password: ${!!account?.password})`
            )
            results.push(codeState)
        }

        let foundStates = results.filter((s): s is LoginState => s !== null)

        if (foundStates.length === 0) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', 'No matching states found')
            return 'UNKNOWN'
        }

        if (foundStates.includes('ERROR_ALERT')) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'DETECT-STATE',
                `ERROR_ALERT found - hostname: ${url.hostname}, has 2FA: ${foundStates.includes('2FA_TOTP')}`
            )
            if (url.hostname !== 'login.live.com') {
                foundStates = foundStates.filter(s => s !== 'ERROR_ALERT')
            }
            if (foundStates.includes('2FA_TOTP')) {
                foundStates = foundStates.filter(s => s !== 'ERROR_ALERT')
            }
            if (foundStates.includes('ERROR_ALERT')) return 'ERROR_ALERT'
        }

        const priorities: LoginState[] = [
            'ACCOUNT_LOCKED',
            'PASSKEY_VIDEO',
            'PASSKEY_ERROR',
            'KMSI_PROMPT',
            'PASSWORD_INPUT',
            'EMAIL_INPUT',
            'SIGN_IN_ANOTHER_WAY_EMAIL',
            'SIGN_IN_ANOTHER_WAY',
            'LOGIN_PASSWORDLESS',
            '2FA_TOTP'
        ]

        for (const priority of priorities) {
            if (foundStates.includes(priority)) {
                this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `Selected state by priority: ${priority}`)
                return priority
            }
        }

        this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `Returning first found state: ${foundStates[0]}`)
        return foundStates[0] as LoginState
    }

    private async checkSelector(page: Page, selector: string): Promise<boolean> {
        return page
            .waitForSelector(selector, { state: 'visible', timeout: 200 })
            .then(() => true)
            .catch(() => false)
    }

    private async handleState(state: LoginState, page: Page, account: Account): Promise<boolean> {
        this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', `Processing state: ${state}`)

        switch (state) {
            case 'ACCOUNT_LOCKED': {
                const msg = 'Account suspended/banned! Your Microsoft Rewards account has been suspended. Skipping to next account.'
                this.bot.logger.error(this.bot.isMobile, 'LOGIN', msg)
                throw new Error(msg)
            }

            case 'ERROR_ALERT': {
                const alertEl = page.locator(this.selectors.errorAlert)
                const errorMsg = await alertEl.innerText().catch(() => 'Unknown Error')
                this.bot.logger.error(this.bot.isMobile, 'LOGIN', `Account error: ${errorMsg}`)
                throw new Error(`Microsoft login error: ${errorMsg}`)
            }

            case 'LOGGED_IN':
                return true

            case 'EMAIL_INPUT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Entering email')
                await this.emailLogin.enterEmail(page, account.email)
                await page.waitForLoadState('domcontentloaded', { timeout: 2500 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after email entry')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Email entered successfully')
                return true
            }

            case 'PASSWORD_INPUT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Entering password')
                await this.emailLogin.enterPassword(page, account.password)
                await page.waitForLoadState('domcontentloaded', { timeout: 2500 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after password entry')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Password entered successfully')
                return true
            }

            case 'GET_A_CODE': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Attempting to bypass "Get code" via footer')
                await this.bot.browser.utils.ghostClick(page, this.selectors.viewFooter)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after footer click')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Footer clicked, proceeding')
                return true
            }

            case 'GET_A_CODE_2': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Handling "Get a code" flow')
                await this.bot.browser.utils.ghostClick(page, this.selectors.primaryButton)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after primary button click')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Initiating code login handler')
                await this.codeLogin.handle(page)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Code login handler completed successfully')
                return true
            }

            case 'SIGN_IN_ANOTHER_WAY_EMAIL': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Selecting "Send a code to email"')

                const emailSelector = await Promise.race([
                    this.checkSelector(page, this.selectors.emailIcon).then(found =>
                        found ? this.selectors.emailIcon : null
                    ),
                    this.checkSelector(page, this.selectors.emailIconOld).then(found =>
                        found ? this.selectors.emailIconOld : null
                    )
                ])

                if (!emailSelector) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'Email icon not found')
                    return false
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN',
                    `Using ${emailSelector === this.selectors.emailIcon ? 'new' : 'old'} email icon selector`
                )
                await this.bot.browser.utils.ghostClick(page, emailSelector)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after email icon click')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Initiating code login handler')
                await this.codeLogin.handle(page)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Code login handler completed successfully')
                return true
            }

            case 'RECOVERY_EMAIL_INPUT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Recovery email input detected')
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout on recovery page')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Initiating recovery email handler')
                await this.recoveryLogin.handle(page, account?.recoveryEmail)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Recovery email handler completed successfully')
                return true
            }

            case 'CHROMEWEBDATA_ERROR': {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'chromewebdata error detected, attempting recovery')
                try {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', `Navigating to ${this.bot.config.baseURL}`)
                    await page
                        .goto(this.bot.config.baseURL, {
                            waitUntil: 'domcontentloaded',
                            timeout: 10000
                        })
                        .catch(() => {})
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Recovery navigation successful')
                    return true
                } catch {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'Fallback to login.live.com')
                    await page
                        .goto('https://login.live.com/', {
                            waitUntil: 'domcontentloaded',
                            timeout: 10000
                        })
                        .catch(() => {})
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Fallback navigation successful')
                    return true
                }
            }

            case '2FA_TOTP': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'TOTP 2FA authentication required')
                await this.totp2FALogin.handle(page, account.totpSecret)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'TOTP 2FA handler completed successfully')
                return true
            }

            case 'SIGN_IN_ANOTHER_WAY': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Selecting "Use my password"')
                await this.bot.browser.utils.ghostClick(page, this.selectors.passwordIcon)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after password icon click')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Password option selected')
                return true
            }

            case 'KMSI_PROMPT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Accepting KMSI prompt')
                await this.bot.browser.utils.ghostClick(page, this.selectors.primaryButton)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after KMSI acceptance')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'KMSI prompt accepted')
                return true
            }

            case 'PASSKEY_VIDEO':
            case 'PASSKEY_ERROR': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Skipping Passkey prompt')
                await this.bot.browser.utils.ghostClick(page, this.selectors.secondaryButton)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after Passkey skip')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Passkey prompt skipped')
                return true
            }

            case 'LOGIN_PASSWORDLESS': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Handling passwordless authentication')
                await this.passwordlessLogin.handle(page)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after passwordless auth')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Passwordless authentication completed successfully')
                return true
            }

            case 'UNKNOWN': {
                const url = new URL(page.url())
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN',
                    `Unknown state at ${url.hostname}${url.pathname}, waiting`
                )
                return true
            }

            default:
                this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', `Unhandled state: ${state}, continuing`)
                return true
        }
    }

    private async checkForSuspension(page: Page): Promise<boolean> {
        const suspensionIndicators = [
            '#serviceAbuseLandingTitle',
            'text="Your Microsoft Rewards account has been suspended"',
            'text="account has been suspended"',
            'text="engaged in one or more violations"'
        ]

        for (const indicator of suspensionIndicators) {
            let found = false
            if (indicator.startsWith('text=')) {
                const searchText = indicator.replace('text=', '').replace(/"/g, '')
                found = await page.locator(`body`).innerText()
                    .then(text => text.toLowerCase().includes(searchText.toLowerCase()))
                    .catch(() => false)
            } else {
                found = await this.checkSelector(page, indicator)
            }
            if (found) {
                this.bot.logger.warn(this.bot.isMobile, 'BAN-CHECK', `Suspension indicator found: ${indicator}`)
                return true
            }
        }
        return false
    }

    private async finalizeLogin(page: Page, email: string) {
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Finalizing login')

        await page.goto(this.bot.config.baseURL, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {})

        // Check for account suspension/ban on the rewards page
        const isSuspended = await this.checkForSuspension(page)
        if (isSuspended) {
            throw new Error('Account suspended/banned! Your Microsoft Rewards account has been suspended. Skipping to next account.')
        }

        const loginRewardsSuccess = new URL(page.url()).hostname === 'rewards.bing.com'
        if (loginRewardsSuccess) {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Logged into Microsoft Rewards successfully')
        } else {
            this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'Could not verify Rewards Dashboard, assuming login valid')
        }

        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Starting Bing session verification')
        await this.verifyBingSession(page)

        // After Bing verification, return to Rewards before modern/token checks.
        await page.goto(this.bot.config.baseURL, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})

        const isModernDashboard = await this.isModernRewardsDashboard(page)
        if (isModernDashboard) {
            this.bot.rewardsVersion = 'modern'
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN',
                'Modern Rewards dashboard detected. Using panel flyout method.'
            )
        } else {
            this.bot.rewardsVersion = 'legacy'
            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Starting rewards session verification')
            await this.getRewardsSession(page)
        }

        const browser = page.context()
        const cookies = await browser.cookies()
        this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `Retrieved ${cookies.length} cookies`)
        await saveSessionData(this.bot.config.sessionPath, cookies, email, this.bot.isMobile)

        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Login completed, session saved')
    }

    private async isModernRewardsDashboard(page: Page): Promise<boolean> {
        try {
            const hostname = new URL(page.url()).hostname
            if (hostname !== 'rewards.bing.com') {
                await page.goto(this.bot.config.baseURL, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})
            }

            await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
            const html = await page.content()
            const isModern = html.includes('self.__next_f.push')
            this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `Modern dashboard detection | nextFMarker=${isModern}`)
            return isModern
        } catch {
            return false
        }
    }

    async verifyBingSession(page: Page) {
        const url =
            'https://www.bing.com/fd/auth/signin?action=interactive&provider=windows_live_id&return_url=https%3A%2F%2Fwww.bing.com%2F'
        const loopMax = 5
        const pollMs = 400

        this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', 'Verifying Bing session')

        try {
            // domcontentloaded is enough for redirects; networkidle often adds several seconds on Bing.
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})

            // Check for and dismiss any passkey prompts
            await this.tryDismissPasskey(page)

            for (let i = 0; i < loopMax; i++) {
                if (page.isClosed()) break

                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', `Verification loop ${i + 1}/${loopMax}`)

                // Check for passkey prompts on each loop iteration
                await this.tryDismissPasskey(page)

                const u = new URL(page.url())
                const atBingHome = u.hostname === 'www.bing.com' && u.pathname === '/'
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN-BING',
                    `At Bing home: ${atBingHome} (${u.hostname}${u.pathname})`
                )

                if (atBingHome) {
                    await this.bot.browser.utils.tryDismissAllMessages(page).catch(() => {})

                    const signedIn = await page
                        .waitForSelector(this.selectors.bingProfile, { timeout: 2000 })
                        .then(() => true)
                        .catch(() => false)

                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', `Profile element found: ${signedIn}`)

                    if (signedIn || this.bot.isMobile) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', 'Bing session verified successfully')
                        return
                    }
                }

                await this.bot.utils.wait(pollMs)
            }

            this.bot.logger.warn(this.bot.isMobile, 'LOGIN-BING', 'Could not verify Bing session, continuing anyway')
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-BING',
                `Verification error: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async tryDismissPasskey(page: Page): Promise<boolean> {
        try {
            // Check if we're on the passkey interrupt URL
            const currentUrl = new URL(page.url())
            const isPasskeyUrl = currentUrl.hostname === 'account.live.com' && 
                                 currentUrl.pathname === '/interrupt/passkey/enroll'

            const passKeyError = await page.$(this.selectors.passKeyError)

            if (passKeyError || isPasskeyUrl) {
                this.bot.logger.info(
                    this.bot.isMobile, 
                    'PASSKEY-CHECK', 
                    `Passkey prompt detected${isPasskeyUrl ? ' (interrupt URL)' : ''}, dismissing`
                )
                await this.bot.browser.utils.ghostClick(page, this.selectors.secondaryButton)
                await page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'PASSKEY-CHECK', 'Load timeout after Passkey skip')
                })
                this.bot.logger.info(this.bot.isMobile, 'PASSKEY-CHECK', 'Passkey prompt dismissed')
                return true
            }
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'PASSKEY-CHECK',
                `Error checking for passkey: ${error instanceof Error ? error.message : String(error)}`
            )
        }
        return false
    }

    private async getRewardsSession(page: Page) {
        const loopMax = 5
        const retryMax = 3

        this.bot.logger.info(this.bot.isMobile, 'GET-REWARD-SESSION', 'Fetching request token')

        try {
            for (let retry = 0; retry < retryMax; retry++) {
                if (retry > 0) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'GET-REWARD-SESSION',
                        `Retry attempt ${retry}/${retryMax - 1} - reloading page`
                    )
                }

                await page
                    .goto(`${this.bot.config.baseURL}?_=${Date.now()}`, { waitUntil: 'networkidle', timeout: 10000 })
                    .catch(() => {})

                // Check for and dismiss any passkey prompts
                await this.tryDismissPasskey(page)

                for (let i = 0; i < loopMax; i++) {
                    if (page.isClosed()) break

                    this.bot.logger.debug(this.bot.isMobile, 'GET-REWARD-SESSION', `Token fetch loop ${i + 1}/${loopMax}`)

                    const u = new URL(page.url())
                    const atRewardHome = u.hostname === 'rewards.bing.com' && u.pathname === '/'

                    if (atRewardHome) {
                        await this.bot.browser.utils.tryDismissAllMessages(page)

                        const html = await page.content()
                        const $ = await this.bot.browser.utils.loadInCheerio(html)

                        // Detect modern Rewards UI using the Earn-tab marker.
                        const isModernDashboard = await this.isModernRewardsDashboard(page)

                        if (isModernDashboard) {
                            this.bot.rewardsVersion = 'modern'

                            this.bot.logger.warn(
                                this.bot.isMobile,
                                'GET-REWARD-SESSION',
                                'Modern Rewards dashboard detected. This script version may not fully support it.'
                            )

                            this.bot.logger.warn(
                                this.bot.isMobile,
                                'GET-REWARD-SESSION',
                                'RequestToken disabled for this session (expected behavior).'
                            )

                            // Modern UI often does not expose __RequestVerificationToken.
                            // Stop retrying token loops and proceed with panel-flyout based flows.
                            return
                        }
                        this.bot.rewardsVersion = 'legacy'

                        const token =
                            $(this.selectors.requestToken).attr('value') ??
                            $(this.selectors.requestTokenMeta).attr('content') ??
                            null

                        if (token) {
                            this.bot.requestToken = token
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'GET-REWARD-SESSION',
                                `Request token retrieved: ${token.substring(0, 10)}...`
                            )

                            // Claim all available points after getting the token
                            if (this.bot.config.workers.doClaimAllPoints) {
                                await this.claimAllPoints(page)
                            }
                            return
                        }

                        this.bot.logger.debug(this.bot.isMobile, 'GET-REWARD-SESSION', 'Token not found on page')
                    } else {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'GET-REWARD-SESSION',
                            `Not at reward home: ${u.hostname}${u.pathname}`
                        )
                    }
                }

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'GET-REWARD-SESSION',
                    `Token not found after ${loopMax} attempts, will retry if attempts remaining`
                )
            }

            this.bot.logger.warn(
                this.bot.isMobile,
                'GET-REWARD-SESSION',
                'No RequestVerificationToken found, some activities may not work'
            )
        } catch (error) {
            throw this.bot.logger.error(
                this.bot.isMobile,
                'GET-REWARD-SESSION',
                `Fatal error: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    async getAppAccessToken(page: Page, email: string) {
        this.bot.logger.info(this.bot.isMobile, 'GET-APP-TOKEN', 'Requesting mobile access token')
        return await new MobileAccessLogin(this.bot, page).get(email)
    }

    async claimAllPoints(page: Page) {
        try {
            if (!this.bot.requestToken) {
                throw new Error('No RequestVerificationToken available from login session')
            }

            const claimToken = this.bot.requestToken

            // First try through in-page fetch so anti-forgery token + cookies stay in the same browser session context.
            try {
                const browserResult = await page.evaluate(async ({ token }) => {
                    const body = new URLSearchParams({
                        timeZone: '0',
                        __RequestVerificationToken: token
                    })

                    const response = await fetch('/api/claimallpointsasync?X-Requested-With=XMLHttpRequest', {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                            'x-requested-with': 'XMLHttpRequest'
                        },
                        body
                    })

                    const text = await response.text()
                    let data: unknown = null
                    try {
                        data = JSON.parse(text)
                    } catch {
                        data = text
                    }

                    return {
                        ok: response.ok,
                        status: response.status,
                        data
                    }
                }, { token: claimToken })

                if (browserResult.ok && browserResult.data && typeof browserResult.data === 'object') {
                    const data = browserResult.data as { balance?: number; activity?: { points?: number } }
                    if (typeof data.balance === 'number') {
                        const pointsEarned = data.activity?.points ?? 0
                        this.bot.userData.currentPoints = data.balance
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'CLAIM-ALL-POINTS',
                            `✅ Claimed all available points | earned=${pointsEarned} | balance=${data.balance}`
                        )
                    } else {
                        this.bot.logger.info(this.bot.isMobile, 'CLAIM-ALL-POINTS', '✅ Claim all points request succeeded')
                    }
                    return
                }

                const browserBodySnippet =
                    typeof browserResult.data === 'string'
                        ? browserResult.data.slice(0, 300)
                        : browserResult.data && typeof browserResult.data === 'object'
                          ? JSON.stringify(browserResult.data).slice(0, 300)
                          : ''

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'CLAIM-ALL-POINTS',
                    `Browser-context claim failed | status=${browserResult.status} ${
                        browserBodySnippet ? `| body=${browserBodySnippet}` : ''
                    }`
                )
            } catch (browserError) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'CLAIM-ALL-POINTS',
                    `Browser-context claim error | error=${browserError instanceof Error ? browserError.message : String(browserError)}`
                )
            }

            throw new Error('Failed to claim all points via browser context request')

        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'CLAIM-ALL-POINTS',
                `Failed to claim all points: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
}
