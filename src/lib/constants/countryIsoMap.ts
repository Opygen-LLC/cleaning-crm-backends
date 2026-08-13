import { Country } from "../../generated/prisma/enums";

// ─── ISO-3166-1 alpha-2 → Prisma `Country` enum lookup table ──────────────────
//
// Why this exists: the old code tried to derive the enum value at save-time
// by upper-casing the country's *display name* and swapping spaces/punctuation
// for underscores (e.g. "South Korea" → "SOUTH_KOREA"). That silently breaks
// for any country whose enum spelling doesn't match its human-readable name
// 1:1 — the Zod schema then rejects the request with an opaque "invalid enum
// value" error and the admin has no idea why. Concretely:
//   - "South Korea"           → naive: SOUTH_KOREA        actual: KOREA_SOUTH
//   - "North Korea"           → naive: NORTH_KOREA         actual: KOREA_NORTH
//   - "Cote D'Ivoire (Ivory Coast)" → naive: COTE_D_IVOIRE_IVORY_COAST → had
//     no enum value at all (added COTE_D_IVOIRE to the Country enum for this)
//   - "Congo"                 → naive: CONGO                actual: CONGO_REPUBLIC
//   - "Democratic Republic of the Congo" → naive: doesn't match either Congo value
//   - "Myanmar"               → happens to match today, but is one string
//     tweak in the country data package away from silently breaking again
//
// Rather than patch the transform with more and more one-off string rules,
// every ISO code the app can present in the country dropdown is mapped here
// explicitly, once, by hand-verified fact rather than by guessing at string
// shape. `resolveCountryEnum` is the single place that turns whatever the
// client sends (an ISO-3166-1 alpha-2 code, or already a valid enum value)
// into a real `Country` enum member — or `undefined` if it's a code with no
// corresponding value in the enum (small territories/dependencies that
// aren't independent countries, e.g. Bermuda, Puerto Rico, Hong Kong SAR).
export const ISO_TO_COUNTRY_ENUM: Record<string, Country> = {
    AD: Country.ANDORRA, // Andorra
    AE: Country.UNITED_ARAB_EMIRATES, // United Arab Emirates
    AF: Country.AFGHANISTAN, // Afghanistan
    AG: Country.ANTIGUA_AND_BARBUDA, // Antigua And Barbuda
    AL: Country.ALBANIA, // Albania
    AM: Country.ARMENIA, // Armenia
    AO: Country.ANGOLA, // Angola
    AR: Country.ARGENTINA, // Argentina
    AT: Country.AUSTRIA, // Austria
    AU: Country.AUSTRALIA, // Australia
    AZ: Country.AZERBAIJAN, // Azerbaijan
    BA: Country.BOSNIA_AND_HERZEGOVINA, // Bosnia and Herzegovina
    BB: Country.BARBADOS, // Barbados
    BD: Country.BANGLADESH, // Bangladesh
    BE: Country.BELGIUM, // Belgium
    BF: Country.BURKINA_FASO, // Burkina Faso
    BG: Country.BULGARIA, // Bulgaria
    BH: Country.BAHRAIN, // Bahrain
    BI: Country.BURUNDI, // Burundi
    BJ: Country.BENIN, // Benin
    BN: Country.BRUNEI, // Brunei
    BO: Country.BOLIVIA, // Bolivia
    BR: Country.BRAZIL, // Brazil
    BS: Country.BAHAMAS, // The Bahamas
    BT: Country.BHUTAN, // Bhutan
    BW: Country.BOTSWANA, // Botswana
    BY: Country.BELARUS, // Belarus
    BZ: Country.BELIZE, // Belize
    CA: Country.CANADA, // Canada
    CD: Country.CONGO_DEMOCRATIC_REPUBLIC, // Democratic Republic of the Congo
    CF: Country.CENTRAL_AFRICAN_REPUBLIC, // Central African Republic
    CG: Country.CONGO_REPUBLIC, // Congo
    CH: Country.SWITZERLAND, // Switzerland
    CI: Country.COTE_D_IVOIRE, // Cote D'Ivoire (Ivory Coast)
    CL: Country.CHILE, // Chile
    CM: Country.CAMEROON, // Cameroon
    CN: Country.CHINA, // China
    CO: Country.COLOMBIA, // Colombia
    CR: Country.COSTA_RICA, // Costa Rica
    CU: Country.CUBA, // Cuba
    CV: Country.CABO_VERDE, // Cape Verde
    CY: Country.CYPRUS, // Cyprus
    CZ: Country.CZECHIA, // Czech Republic
    DE: Country.GERMANY, // Germany
    DJ: Country.DJIBOUTI, // Djibouti
    DK: Country.DENMARK, // Denmark
    DM: Country.DOMINICA, // Dominica
    DO: Country.DOMINICAN_REPUBLIC, // Dominican Republic
    DZ: Country.ALGERIA, // Algeria
    EC: Country.ECUADOR, // Ecuador
    EE: Country.ESTONIA, // Estonia
    EG: Country.EGYPT, // Egypt
    ER: Country.ERITREA, // Eritrea
    ES: Country.SPAIN, // Spain
    ET: Country.ETHIOPIA, // Ethiopia
    FI: Country.FINLAND, // Finland
    FJ: Country.FIJI, // Fiji Islands
    FM: Country.MICRONESIA, // Micronesia
    FR: Country.FRANCE, // France
    GA: Country.GABON, // Gabon
    GB: Country.UNITED_KINGDOM, // United Kingdom
    GD: Country.GRENADA, // Grenada
    GE: Country.GEORGIA, // Georgia
    GH: Country.GHANA, // Ghana
    GM: Country.GAMBIA, // The Gambia
    GN: Country.GUINEA, // Guinea
    GQ: Country.EQUATORIAL_GUINEA, // Equatorial Guinea
    GR: Country.GREECE, // Greece
    GT: Country.GUATEMALA, // Guatemala
    GW: Country.GUINEA_BISSAU, // Guinea-Bissau
    GY: Country.GUYANA, // Guyana
    HN: Country.HONDURAS, // Honduras
    HR: Country.CROATIA, // Croatia
    HT: Country.HAITI, // Haiti
    HU: Country.HUNGARY, // Hungary
    ID: Country.INDONESIA, // Indonesia
    IE: Country.IRELAND, // Ireland
    IL: Country.ISRAEL, // Israel
    IN: Country.INDIA, // India
    IQ: Country.IRAQ, // Iraq
    IR: Country.IRAN, // Iran
    IS: Country.ICELAND, // Iceland
    IT: Country.ITALY, // Italy
    JM: Country.JAMAICA, // Jamaica
    JO: Country.JORDAN, // Jordan
    JP: Country.JAPAN, // Japan
    KE: Country.KENYA, // Kenya
    KG: Country.KYRGYZSTAN, // Kyrgyzstan
    KH: Country.CAMBODIA, // Cambodia
    KI: Country.KIRIBATI, // Kiribati
    KM: Country.COMOROS, // Comoros
    KN: Country.SAINT_KITTS_AND_NEVIS, // Saint Kitts And Nevis
    KP: Country.KOREA_NORTH, // North Korea
    KR: Country.KOREA_SOUTH, // South Korea
    KW: Country.KUWAIT, // Kuwait
    KZ: Country.KAZAKHSTAN, // Kazakhstan
    LA: Country.LAOS, // Laos
    LB: Country.LEBANON, // Lebanon
    LC: Country.SAINT_LUCIA, // Saint Lucia
    LI: Country.LIECHTENSTEIN, // Liechtenstein
    LK: Country.SRI_LANKA, // Sri Lanka
    LR: Country.LIBERIA, // Liberia
    LS: Country.LESOTHO, // Lesotho
    LT: Country.LITHUANIA, // Lithuania
    LU: Country.LUXEMBOURG, // Luxembourg
    LV: Country.LATVIA, // Latvia
    LY: Country.LIBYA, // Libya
    MA: Country.MOROCCO, // Morocco
    MC: Country.MONACO, // Monaco
    MD: Country.MOLDOVA, // Moldova
    ME: Country.MONTENEGRO, // Montenegro
    MG: Country.MADAGASCAR, // Madagascar
    MH: Country.MARSHALL_ISLANDS, // Marshall Islands
    MK: Country.NORTH_MACEDONIA, // Macedonia
    ML: Country.MALI, // Mali
    MM: Country.MYANMAR, // Myanmar
    MN: Country.MONGOLIA, // Mongolia
    MR: Country.MAURITANIA, // Mauritania
    MT: Country.MALTA, // Malta
    MU: Country.MAURITIUS, // Mauritius
    MV: Country.MALDIVES, // Maldives
    MW: Country.MALAWI, // Malawi
    MX: Country.MEXICO, // Mexico
    MY: Country.MALAYSIA, // Malaysia
    MZ: Country.MOZAMBIQUE, // Mozambique
    NA: Country.NAMIBIA, // Namibia
    NE: Country.NIGER, // Niger
    NG: Country.NIGERIA, // Nigeria
    NI: Country.NICARAGUA, // Nicaragua
    NL: Country.NETHERLANDS, // Netherlands
    NO: Country.NORWAY, // Norway
    NP: Country.NEPAL, // Nepal
    NR: Country.NAURU, // Nauru
    NZ: Country.NEW_ZEALAND, // New Zealand
    OM: Country.OMAN, // Oman
    PA: Country.PANAMA, // Panama
    PE: Country.PERU, // Peru
    PG: Country.PAPUA_NEW_GUINEA, // Papua new Guinea
    PH: Country.PHILIPPINES, // Philippines
    PK: Country.PAKISTAN, // Pakistan
    PL: Country.POLAND, // Poland
    PS: Country.PALESTINE, // Palestinian Territory Occupied
    PT: Country.PORTUGAL, // Portugal
    PW: Country.PALAU, // Palau
    PY: Country.PARAGUAY, // Paraguay
    QA: Country.QATAR, // Qatar
    RO: Country.ROMANIA, // Romania
    RS: Country.SERBIA, // Serbia
    RU: Country.RUSSIA, // Russia
    RW: Country.RWANDA, // Rwanda
    SA: Country.SAUDI_ARABIA, // Saudi Arabia
    SB: Country.SOLOMON_ISLANDS, // Solomon Islands
    SC: Country.SEYCHELLES, // Seychelles
    SD: Country.SUDAN, // Sudan
    SE: Country.SWEDEN, // Sweden
    SG: Country.SINGAPORE, // Singapore
    SI: Country.SLOVENIA, // Slovenia
    SK: Country.SLOVAKIA, // Slovakia
    SL: Country.SIERRA_LEONE, // Sierra Leone
    SM: Country.SAN_MARINO, // San Marino
    SN: Country.SENEGAL, // Senegal
    SO: Country.SOMALIA, // Somalia
    SR: Country.SURINAME, // Suriname
    SS: Country.SOUTH_SUDAN, // South Sudan
    ST: Country.SAO_TOME_AND_PRINCIPE, // Sao Tome and Principe
    SV: Country.EL_SALVADOR, // El Salvador
    SY: Country.SYRIA, // Syria
    SZ: Country.ESWATINI, // Swaziland
    TD: Country.CHAD, // Chad
    TG: Country.TOGO, // Togo
    TH: Country.THAILAND, // Thailand
    TJ: Country.TAJIKISTAN, // Tajikistan
    TL: Country.TIMOR_LESTE, // East Timor
    TM: Country.TURKMENISTAN, // Turkmenistan
    TN: Country.TUNISIA, // Tunisia
    TO: Country.TONGA, // Tonga
    TR: Country.TURKEY, // Turkey
    TT: Country.TRINIDAD_AND_TOBAGO, // Trinidad And Tobago
    TV: Country.TUVALU, // Tuvalu
    TZ: Country.TANZANIA, // Tanzania
    UA: Country.UKRAINE, // Ukraine
    UG: Country.UGANDA, // Uganda
    US: Country.UNITED_STATES, // United States
    UY: Country.URUGUAY, // Uruguay
    UZ: Country.UZBEKISTAN, // Uzbekistan
    VA: Country.VATICAN_CITY, // Vatican City State (Holy See)
    VC: Country.SAINT_VINCENT_AND_THE_GRENADINES, // Saint Vincent And The Grenadines
    VE: Country.VENEZUELA, // Venezuela
    VN: Country.VIETNAM, // Vietnam
    VU: Country.VANUATU, // Vanuatu
    WS: Country.SAMOA, // Samoa
    XK: Country.KOSOVO, // Kosovo
    YE: Country.YEMEN, // Yemen
    ZA: Country.SOUTH_AFRICA, // South Africa
    ZM: Country.ZAMBIA, // Zambia
    ZW: Country.ZIMBABWE, // Zimbabwe
};

/**
 * Resolves whatever the client sent for "country" into a real Prisma
 * `Country` enum member.
 *
 * Accepts, in order:
 *   1. An ISO-3166-1 alpha-2 code (e.g. "KR") — the normal case; this is
 *      what the frontend's country dropdown (country-state-city) provides
 *      via `isoCode`.
 *   2. A value that is already a valid `Country` enum member (e.g.
 *      "KOREA_SOUTH") — kept for backwards compatibility with any existing
 *      integrations / stored data that already send the enum form directly.
 *
 * Returns `undefined` if neither resolves to a supported country, so the
 * caller can reject the request with a clear, actionable error instead of
 * letting Prisma/Zod fail with a cryptic enum-mismatch message.
 */
export const resolveCountryEnum = (input: string): Country | undefined => {
    if (!input) return undefined;

    const trimmed = input.trim();

    const byIso = ISO_TO_COUNTRY_ENUM[trimmed.toUpperCase()];
    if (byIso) return byIso;

    if ((Object.values(Country) as string[]).includes(trimmed)) {
        return trimmed as Country;
    }

    return undefined;
};
/** Convert a stored Prisma Country enum back to its ISO-3166-1 alpha-2 code. */
export const countryEnumToIso = (country: Country | null | undefined): string | undefined => {
    if (!country) return undefined;
    return Object.entries(ISO_TO_COUNTRY_ENUM).find(([, value]) => value === country)?.[0];
};
