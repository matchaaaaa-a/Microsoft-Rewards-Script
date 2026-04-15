import type { MicrosoftRewardsBot } from '../index'
import { resolveGeminiApiKeys } from '../util/geminiApiKeys'

export class GeminiQueryEngine {
    private apiKeys: string[]
    private currentKeyIndex: number = 0
    private ai: any
    private aiReady: Promise<void>

    constructor(private bot: MicrosoftRewardsBot) {
        this.apiKeys = resolveGeminiApiKeys(this.bot.config)
        this.aiReady = this.createAiClient(this.apiKeys[0] ?? '')
    }

    private async createAiClient(apiKey: string): Promise<void> {
        const mod = await import('@google/genai')
        this.ai = new mod.GoogleGenAI({ apiKey })
    }

    private async ensureAiReady(): Promise<void> {
        await this.aiReady
    }

    private async rotateApiKey(): Promise<void> {
        if (this.apiKeys.length === 0) {
            return
        }
        this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length
        const newKey = this.apiKeys[this.currentKeyIndex]!
        this.aiReady = this.createAiClient(newKey)
        await this.aiReady
        this.bot.logger.info(
            this.bot.isMobile,
            'GEMINI-QUERY-ENGINE',
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

    async generateSearchQueries(): Promise<string[]> {
        const prompt = `You are an expert at mimicking real, authentic Google search behavior from everyday people worldwide. Generate a JSON array with exactly 120 unique items. Each item must be a realistic search query that feels like something a normal person would actually search for:

REALISTIC SEARCH PATTERNS TO INCLUDE:
- Practical how-to searches (cooking, repairs, DIY, tutorials)
- Entertainment (movies, shows, music, games, celebrities)
- Shopping (prices, reviews, comparisons, deals)
- Local services (restaurants, stores, directions, hours)
- Health & fitness (workouts, diets, symptoms, supplements)
- Technology (phones, computers, apps, gadgets)
- Travel & weather (flights, hotels, forecasts, destinations)
- News & current events (breaking news, sports scores, politics)
- Work/school (job searches, homework help, productivity tips)
- Hobbies & interests (books, sports, crafts, gaming)
- Relationships & social (dating advice, family issues, friendships)
- Home & garden (cleaning, decorating, repairs, plants)
- Finance (budgeting, investing, taxes, banking)
- Food & recipes (restaurants, cooking methods, ingredients)
- Random daily questions (what time is it, calculator, unit conversions)

SEARCH CHARACTERISTICS:
- Longer, more detailed queries (8-20 words typical)
- Natural typing patterns (lowercase, abbreviations, typos sometimes)
- Include question words: what, how, why, where, when, which, best, cheapest, fastest
- Add casual phrases: "near me", "right now", "this week", "for beginners", "step by step"
- Include brand names, product models, celebrity names, specific requirements
- Some searches with locations: "in [city]", "near [place]", "in my area"
- Mix current/popular topics with evergreen searches
- Include specific details like prices, features, requirements, comparisons

DISTRIBUTION GUIDELINES:
- 15-20 practical how-to searches
- 15-20 shopping/product searches
- 10-15 entertainment/media searches
- 10-15 local service searches
- 8-12 health/fitness searches
- 8-12 technology searches
- 8-12 news/current events
- 8-12 work/school searches
- 6-10 travel/weather searches
- 6-10 food/recipe searches
- 6-10 finance searches
- 6-10 home/garden searches
- 4-8 relationship/social searches
- 4-8 hobby/sport searches

EXAMPLES OF REALISTIC LONGER SEARCHES:
"best wireless earbuds under 100 dollars with good battery life and noise cancelling features"
"how to fix a leaky faucet step by step guide for beginners with tools needed"
"netflix shows to watch this weekend that are good for binge watching with family"
"italian restaurants near union square that are open late and have outdoor seating"
"what are the symptoms of covid right now and how long do they typically last"
"iphone 15 pro max vs samsung s24 ultra camera comparison and which is better value"
"weather forecast for next 10 days including temperature highs and lows for my location"
"how to make homemade pizza dough from scratch with step by step instructions"
"cheapest flights from nyc to london this month with layovers and total travel time"
"best workout routine for beginners at home that requires no equipment and takes 30 minutes"
"what time does target open today and do they have the ps5 restock in stock"
"how to remove wine stains from carpet using household items and professional cleaners"
"best movies on hulu right now that are critically acclaimed and have high ratings"
"costco membership fee 2024 and what benefits do you get with the gold star membership"
"how long to boil eggs for hard boiled and how to tell when they are perfectly done"
"jobs hiring near me no experience required and paying at least 15 dollars per hour"
"best hiking trails in colorado for families with kids that are not too strenuous"
"how to change oil in car yourself step by step with pictures and common mistakes to avoid"
"current gas prices in my area and which gas station has the cheapest unleaded today"
"best noise cancelling headphones 2024 with wireless charging and comfortable for long flights"

Output ONLY valid JSON — nothing else — exactly like this:

[
  "best wireless earbuds under 100 dollars",
  "how to fix a leaky faucet step by step",
  "netflix shows to watch this weekend",
  "italian restaurants near union square",
  "what are the symptoms of covid right now",
  ...
]

Ensure all 120 are unique, realistic searches that real people would actually type. Start directly with [ and end with ] — no intro, no explanations, no extra text.`

        let attempt = 0
        let consecutiveFailures = 0
        const maxConsecutiveFailures = 3 // Max failures per key before rotating

        while (true) {
            attempt++

            try {
                await this.ensureAiReady()
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'GEMINI-QUERY-ENGINE',
                    `Attempt ${attempt}: Generating search queries using Gemini API (Key ${this.currentKeyIndex + 1}/${this.apiKeys.length})`
                )

                const response = await this.ai.models.generateContent({
                    model: "gemini-3-flash-preview",
                    contents: prompt,
                })

                if (!response.text) {
                    throw new Error('No text response from Gemini API')
                }

                const text = response.text

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'GEMINI-QUERY-ENGINE',
                    `Gemini API response received | length=${text.length}`
                )

                // Parse the JSON response
                const queries = this.parseJsonResponse(text)

                this.bot.logger.info(
                    this.bot.isMobile,
                    'GEMINI-QUERY-ENGINE',
                    `✅ Generated ${queries.length} search queries from Gemini API (attempt ${attempt}, key ${this.currentKeyIndex + 1}/${this.apiKeys.length})`
                )

                return queries

            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error)
                consecutiveFailures++

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'GEMINI-QUERY-ENGINE',
                    `Attempt ${attempt} failed (Key ${this.currentKeyIndex + 1}/${this.apiKeys.length}): ${errorMessage}`
                )

                // Check if this is a rate limit error
                if (this.isRateLimitError(error)) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'GEMINI-QUERY-ENGINE',
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
                        'GEMINI-QUERY-ENGINE',
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
                    'GEMINI-QUERY-ENGINE',
                    `Waiting 30 seconds before retry ${attempt + 1}...`
                )
                await this.bot.utils.wait(30000)
            }
        }
    }

    private parseJsonResponse(response: string): string[] {
        try {
            // Parse the JSON response
            const queries = JSON.parse(response)

            // Ensure it's an array
            if (!Array.isArray(queries)) {
                throw new Error(`Response is not a JSON array: ${typeof queries}`)
            }

            // Filter out any non-string items and trim
            const validQueries = queries
                .filter((query): query is string => typeof query === 'string')
                .map(query => query.trim())
                .filter(query => query.length > 0)

            if (validQueries.length === 0) {
                throw new Error('No valid string queries found in JSON response')
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'GEMINI-QUERY-ENGINE',
                `Parsed ${validQueries.length} queries from JSON response`
            )

            return validQueries
        } catch (error) {
            throw new Error(`Failed to parse JSON response: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

}
