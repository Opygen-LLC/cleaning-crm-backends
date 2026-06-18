/**
 * paypal.helper.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PayPal Commerce Platform (PPCP) partner-referral helper.
 *
 * Creates a partner-referral request that generates a PayPal-hosted onboarding
 * URL. The business owner clicks that URL, completes PayPal's onboarding flow,
 * and is redirected back to FRONTEND_URL/oauth/callback/paypal?merchantId=…
 *
 * Required env vars:
 *   PAYPAL_CLIENT_ID   — platform app client ID
 *   PAYPAL_SECRET      — platform app secret
 *   PAYPAL_SANDBOX     — "true" | "false"
 *   PAYPAL_PARTNER_ID  — platform's PayPal merchant/partner ID (payer_id)
 *   FRONTEND_URL       — e.g. https://app.example.com
 */

const getPayPalBase = () =>
    process.env.PAYPAL_SANDBOX === "true"
        ? "https://api-m.sandbox.paypal.com"
        : "https://api-m.paypal.com";

// ─── Get platform access token ────────────────────────────────────────────────
const getPayPalAccessToken = async (base: string): Promise<string> => {
    const credentials = Buffer.from(
        `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`,
    ).toString("base64");

    const res = await fetch(`${base}/v1/oauth2/token`, {
        method: "POST",
        headers: {
            Authorization: `Basic ${credentials}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`PayPal token request failed (${res.status}): ${text}`);
    }

    const { access_token } = (await res.json()) as { access_token: string };
    return access_token;
};

// ─── createPayPalReferralUrl ──────────────────────────────────────────────────
/**
 * Posts to /v2/customer/partner-referrals and returns the action_url the
 * business owner must visit to complete PayPal onboarding.
 *
 * @param adminId  - used as tracking_id so you can correlate the callback
 * @returns        - the PayPal-hosted onboarding action URL
 */
export const createPayPalReferralUrl = async (
    adminId: string,
): Promise<string> => {
    const base = getPayPalBase();
    const access_token = await getPayPalAccessToken(base);

    const res = await fetch(`${base}/v2/customer/partner-referrals`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${access_token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            tracking_id: adminId,
            partner_config_override: {
                partner_logo_url:
                    process.env.PAYPAL_PARTNER_LOGO_URL ?? undefined,
                return_url: `${process.env.FRONTEND_URL}/oauth/callback/paypal`,
                return_url_description: "Return to dashboard",
                action_renewal_url: `${process.env.FRONTEND_URL}/oauth/callback/paypal`,
            },
            operations: [
                {
                    operation: "API_INTEGRATION",
                    api_integration_preference: {
                        rest_api_integration: {
                            integration_method: "PAYPAL",
                            integration_type: "THIRD_PARTY",
                            third_party_details: {
                                features: ["PAYMENT", "REFUND", "PARTNER_FEE"],
                            },
                        },
                    },
                },
            ],
            products: ["PPCP"],
            legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
        }),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(
            `PayPal partner-referrals request failed (${res.status}): ${text}`,
        );
    }

    const { links } = (await res.json()) as {
        links: { rel: string; href: string; method?: string }[];
    };

    const actionUrl = links.find((l) => l.rel === "action_url")?.href;
    if (!actionUrl) {
        throw new Error(
            "PayPal partner-referrals response missing action_url link",
        );
    }

    return actionUrl;
};
