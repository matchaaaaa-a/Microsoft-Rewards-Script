import type { AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { Session } from 'httpcloak'
import { URL } from 'url'
import type { AccountProxy } from '../interface/Account'

const DEFAULT_RETRY_STATUS_CODES = [429, 500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511]
const DESKTOP_PRESET = 'chrome-146-windows'
const MOBILE_PRESET = 'chrome-146-android'
const BASE_SESSION_OPTIONS = {
    timeout: 20,
    retry: 5,
    retryWaitMin: 500,
    retryWaitMax: 10000,
    retryOnStatus: DEFAULT_RETRY_STATUS_CODES
} as const

class AxiosClient {
    private desktopSession: Session
    private mobileSession: Session
    private directDesktopSession: Session
    private directMobileSession: Session
    private account: AccountProxy
    private debugEnabled: boolean

    constructor(account: AccountProxy, _options?: { debug?: boolean }) {
        this.account = account
        // Keep httpcloak logs silent to avoid noisy console output.
        this.debugEnabled = false

        this.directDesktopSession = new Session({
            ...BASE_SESSION_OPTIONS,
            preset: DESKTOP_PRESET
        })
        this.directMobileSession = new Session({
            ...BASE_SESSION_OPTIONS,
            preset: MOBILE_PRESET
        })

        const proxy = this.account.url && this.account.proxyAxios ? this.getProxyUrl(this.account) : undefined
        this.desktopSession = new Session({
            ...BASE_SESSION_OPTIONS,
            preset: DESKTOP_PRESET,
            proxy
        })
        this.mobileSession = new Session({
            ...BASE_SESSION_OPTIONS,
            preset: MOBILE_PRESET,
            proxy
        })
    }

    private getProxyUrl(proxyConfig: AccountProxy): string {
        const { url: baseUrl, port, username, password } = proxyConfig

        let urlObj: URL
        try {
            urlObj = new URL(baseUrl)
        } catch (e) {
            try {
                urlObj = new URL(`http://${baseUrl}`)
            } catch (error) {
                throw new Error(`Invalid proxy URL format: ${baseUrl}`)
            }
        }

        const protocol = urlObj.protocol.toLowerCase()
        if (username && password) {
            urlObj.username = encodeURIComponent(username)
            urlObj.password = encodeURIComponent(password)
            urlObj.port = port.toString()
            return urlObj.toString()
        }
        const proxyUrl = `${protocol}//${urlObj.hostname}:${port}`

        if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(protocol)) {
            throw new Error(`Unsupported proxy protocol: ${protocol}. Only HTTP(S) and SOCKS4/5 are supported!`)
        }
        return proxyUrl
    }

    private normalizeHeaders(headers?: AxiosRequestConfig['headers']): Record<string, string> | undefined {
        if (!headers) return undefined

        const maybeHeaders = headers as { toJSON?: () => unknown }
        const source =
            typeof maybeHeaders.toJSON === 'function'
                ? (maybeHeaders.toJSON() as Record<string, unknown>)
                : (headers as Record<string, unknown>)

        return Object.fromEntries(
            Object.entries(source ?? {})
                .filter(([, value]) => value !== undefined && value !== null)
                .map(([key, value]) => [key, String(value)])
        )
    }

    private normalizeParams(params: AxiosRequestConfig['params']): Record<string, string | number | boolean> | undefined {
        if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined

        const out: Record<string, string | number | boolean> = {}
        for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                out[key] = value
            }
        }
        return out
    }

    private getHeaderAsString(headers: Record<string, unknown>, headerName: string): string {
        const direct = headers[headerName]
        const lowered = headers[headerName.toLowerCase()]
        const upper = headers[headerName.toUpperCase()]
        const value = direct ?? lowered ?? upper

        if (typeof value === 'string') return value
        if (Array.isArray(value)) {
            const first = value.find(v => typeof v === 'string')
            return typeof first === 'string' ? first : ''
        }
        return value === undefined || value === null ? '' : String(value)
    }

    private parseResponseData(response: { text: string; headers: Record<string, unknown> }): unknown {
        const contentType = this.getHeaderAsString(response.headers, 'content-type').toLowerCase()
        const trimmed = response.text.trim()
        const looksLikeJson =
            trimmed.startsWith('{') || trimmed.startsWith('[') || contentType.includes('application/json')

        if (looksLikeJson) {
            try {
                return JSON.parse(trimmed)
            } catch {
                return response.text
            }
        }
        return response.text
    }

    private maskHeaderValue(key: string, value: string): string {
        const lowerKey = key.toLowerCase()
        if (
            lowerKey.includes('cookie') ||
            lowerKey.includes('authorization') ||
            lowerKey.includes('token') ||
            lowerKey.includes('api-key') ||
            lowerKey.includes('apikey') ||
            lowerKey.includes('x-ms-client-request-id')
        ) {
            if (!value) return value
            return `${value.slice(0, 12)}...`
        }
        return value
    }

    private maskSensitiveInBody(body: string): string {
        return body
            .replace(/(__RequestVerificationToken=)[^&]+/gi, '$1***')
            .replace(/(Authorization["']?\s*:\s*["'])[^"']+/gi, '$1***')
            .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/=]+/gi, '$1***')
    }

    private stringifyPayloadForLog(body: unknown, json: unknown): string {
        if (typeof body === 'string') {
            return this.maskSensitiveInBody(body).slice(0, 800)
        }
        if (Buffer.isBuffer(body)) {
            return `[buffer length=${body.length}]`
        }
        if (json && typeof json === 'object') {
            try {
                return this.maskSensitiveInBody(JSON.stringify(json)).slice(0, 800)
            } catch {
                return '[json payload]'
            }
        }
        if (body === undefined && json === undefined) {
            return '[empty]'
        }
        return String(body ?? json).slice(0, 800)
    }

    private logRequest(
        method: string,
        url: string,
        headers: Record<string, string> | undefined,
        params: Record<string, string | number | boolean> | undefined,
        body: unknown,
        json: unknown
    ): void {
        if (!this.debugEnabled) return
        const safeHeaders = Object.fromEntries(
            Object.entries(headers ?? {}).map(([key, value]) => [key, this.maskHeaderValue(key, value)])
        )
        const payload = this.stringifyPayloadForLog(body, json)
        console.log(
            `[HTTPCLOAK][REQ] ${method} ${url} | headers=${JSON.stringify(safeHeaders)} | params=${JSON.stringify(params ?? {})} | payload=${payload}`
        )
    }

    private logResponse(method: string, url: string, statusCode: number, responseText: string): void {
        if (!this.debugEnabled) return
        const snippet = this.maskSensitiveInBody(responseText).slice(0, 800)
        console.log(`[HTTPCLOAK][RES] ${method} ${url} | status=${statusCode} | body=${snippet}`)
    }

    private resolveSession(bypassProxy: boolean, mobileRequest: boolean): Session {
        if (bypassProxy) {
            return mobileRequest ? this.directMobileSession : this.directDesktopSession
        }
        return mobileRequest ? this.mobileSession : this.desktopSession
    }

    private isMobileRequest(url: string, headers?: Record<string, string>): boolean {
        const lowerUrl = url.toLowerCase()
        const userAgent = (headers?.['user-agent'] ?? headers?.['User-Agent'] ?? '').toLowerCase()
        const chMobile = (headers?.['sec-ch-ua-mobile'] ?? headers?.['Sec-CH-UA-Mobile'] ?? '').toLowerCase()

        if (userAgent.includes('android') || userAgent.includes('mobile') || userAgent.includes('edga/')) {
            return true
        }
        if (chMobile === '?1' || chMobile === '1' || chMobile === 'true') {
            return true
        }
        return lowerUrl.includes('/api/mobile') || lowerUrl.includes('microsoft.com/rewardsapp')
    }

    public async request(config: AxiosRequestConfig, bypassProxy = false): Promise<AxiosResponse> {
        if (!config.url) {
            throw new Error('Request URL is required')
        }

        const method = (config.method ?? 'GET').toUpperCase()
        const headers = this.normalizeHeaders(config.headers)
        const mobileRequest = this.isMobileRequest(config.url, headers)
        const session = this.resolveSession(bypassProxy, mobileRequest)
        const params = this.normalizeParams(config.params)
        const timeoutSeconds = config.timeout ? Math.max(1, Math.ceil(config.timeout / 1000)) : undefined
        const auth: [string, string] | undefined =
            config.auth && typeof config.auth.username === 'string'
                ? [config.auth.username, config.auth.password ?? '']
                : undefined

        const body =
            config.data === undefined
                ? undefined
                : Buffer.isBuffer(config.data) || typeof config.data === 'string'
                  ? config.data
                  : config.data instanceof URLSearchParams
                    ? config.data.toString()
                  : typeof config.data === 'object' && config.data !== null
                    ? undefined
                    : String(config.data)
        const json =
            config.data !== undefined &&
            typeof config.data === 'object' &&
            !Buffer.isBuffer(config.data) &&
            !(config.data instanceof URLSearchParams) &&
            config.data !== null
                ? (config.data as Record<string, any>)
                : undefined

        this.logRequest(method, config.url, headers, params, body, json)

        const response = await session.request(method, config.url, {
            headers,
            params,
            timeout: timeoutSeconds,
            auth,
            body,
            json
        })
        this.logResponse(method, config.url, response.statusCode, response.text)

        const responseConfig: InternalAxiosRequestConfig = {
            ...(config as InternalAxiosRequestConfig),
            headers: (config.headers ?? {}) as InternalAxiosRequestConfig['headers']
        }

        const axiosLikeResponse: AxiosResponse = {
            data: this.parseResponseData(response),
            status: response.statusCode,
            statusText: response.reason ?? '',
            headers: response.headers,
            config: responseConfig,
            request: undefined
        }

        const validateStatus = config.validateStatus ?? ((status: number) => status >= 200 && status < 300)
        if (!validateStatus(response.statusCode)) {
            const error = new Error(`Request failed with status code ${response.statusCode}`) as Error & {
                response: AxiosResponse
                config: AxiosRequestConfig
            }
            error.response = axiosLikeResponse
            error.config = config
            throw error
        }

        return axiosLikeResponse
    }
}

export default AxiosClient
