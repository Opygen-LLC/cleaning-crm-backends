import { Currency } from "../../generated/prisma/enums";

export const formatMoney = (
  value: number | string | { toString(): string } | null | undefined,
  currency: Currency | string = Currency.USD,
): string => {
  const amount = Number(value ?? 0);
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: String(currency),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safeAmount);
  } catch {
    return `${String(currency)} ${safeAmount.toFixed(2)}`;
  }
};

export const currencyPrefix = (currency: Currency | string): string => {
  try {
    const parts = new Intl.NumberFormat("en", {
      style: "currency",
      currency: String(currency),
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).formatToParts(0);
    return parts.find((part) => part.type === "currency")?.value ?? `${currency} `;
  } catch {
    return `${currency} `;
  }
};
