export type EvidenceSource =
  | "EXTENDED_REST_ACCOUNT"
  | "EXTENDED_REST_BALANCE"
  | "EXTENDED_REST_POSITIONS"
  | "EXTENDED_REST_OPEN_ORDERS"
  | "EXTENDED_REST_LEVERAGE"
  | "EXTENDED_ACCOUNT_WS"
  | "EXTENDED_MARK_PRICE";

export type SourceEvidence<T> = {
  source: EvidenceSource;
  ok: boolean;
  value?: T;
  requestStartedAt: string;
  responseCompletedAt: string;
  sourceUpdatedAt?: string;
  lastSuccessfulAt?: string;
  accountId?: string;
  errorCode?: string;
};

export type StrictAccountIdentity = {
  accountId: string;
  l2Vault?: string;
  status?: string;
};

export type StrictBalance = {
  equity: number;
  balance?: number;
  availableForTrade?: number;
  unrealizedPnl?: number;
  updatedAt?: string;
};

export type StrictPosition = {
  accountId?: string;
  market: string;
  size: number;
  side: "LONG" | "SHORT";
  markPrice?: number;
  openPrice?: number;
  unrealizedPnl?: number;
  liquidationPrice?: number;
  updatedAt?: string;
};

export type StrictOpenOrder = {
  accountId?: string;
  id: string;
  externalId?: string;
  market: string;
  side: "BUY" | "SELL";
  price: number;
  qty: number;
  filledQty: number;
  status: string;
  updatedAt?: string;
};

export type StrictLeverage = {
  market: string;
  leverage: number;
};

export type StrictMarkPrice = {
  market: string;
  markPrice: number;
  updatedAt?: string;
};

export type ExtendedStrictExchangeFacade = {
  strictReadAccountDetails(): Promise<unknown>;
  strictReadBalance(): Promise<unknown>;
  strictReadPositions(market: string): Promise<unknown>;
  strictReadOpenOrders(market: string): Promise<unknown>;
  strictReadLeverage(market: string): Promise<unknown>;
  strictReadMarkPrice(market: string): Promise<unknown>;
};

function isoFromMillis(value: unknown): string | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  const millis = number < 10_000_000_000 ? number * 1000 : number;
  const date = new Date(millis);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function finite(value: unknown, name: string, options: { positive?: boolean } = {}): number {
  const number = Number(value);
  if (!Number.isFinite(number) || (options.positive && number <= 0)) {
    throw new Error(`EXTENDED_STRICT_INVALID_${name.toUpperCase()}`);
  }
  return number;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === "object") return [value as Record<string, unknown>];
  if (value == null) return [];
  throw new Error("EXTENDED_STRICT_INVALID_ROWS");
}

function errorCode(error: unknown): string {
  const candidate = error as { code?: unknown; message?: unknown };
  return String(candidate?.code || candidate?.message || "EXTENDED_STRICT_READ_FAILED").slice(0, 160);
}

function latestTimestamp(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1);
}

export class ExtendedStrictApi {
  private readonly lastSuccessful = new Map<EvidenceSource, string>();

  constructor(
    private readonly exchange: ExtendedStrictExchangeFacade,
    private readonly now: () => number = Date.now
  ) {}

  private async read<T>(
    source: EvidenceSource,
    request: () => Promise<unknown>,
    parse: (raw: unknown) => { value: T; sourceUpdatedAt?: string; accountId?: string }
  ): Promise<SourceEvidence<T>> {
    const requestStartedAt = new Date(this.now()).toISOString();
    try {
      const parsed = parse(await request());
      const responseCompletedAt = new Date(this.now()).toISOString();
      this.lastSuccessful.set(source, responseCompletedAt);
      return {
        source,
        ok: true,
        value: parsed.value,
        requestStartedAt,
        responseCompletedAt,
        sourceUpdatedAt: parsed.sourceUpdatedAt,
        lastSuccessfulAt: responseCompletedAt,
        accountId: parsed.accountId,
      };
    } catch (error) {
      return {
        source,
        ok: false,
        requestStartedAt,
        responseCompletedAt: new Date(this.now()).toISOString(),
        lastSuccessfulAt: this.lastSuccessful.get(source),
        errorCode: errorCode(error),
      };
    }
  }

  account(): Promise<SourceEvidence<StrictAccountIdentity>> {
    return this.read("EXTENDED_REST_ACCOUNT", () => this.exchange.strictReadAccountDetails(), (raw) => {
      const row = rows(raw)[0];
      const accountId = row?.accountId;
      if (accountId == null || String(accountId) === "") {
        throw new Error("EXTENDED_STRICT_ACCOUNT_ID_MISSING");
      }
      return {
        value: {
          accountId: String(accountId),
          l2Vault: row.l2Vault == null ? undefined : String(row.l2Vault),
          status: row.status == null ? undefined : String(row.status),
        },
        accountId: String(accountId),
      };
    });
  }

  balance(): Promise<SourceEvidence<StrictBalance>> {
    return this.read("EXTENDED_REST_BALANCE", () => this.exchange.strictReadBalance(), (raw) => {
      const row = rows(raw)[0];
      if (!row) throw new Error("EXTENDED_STRICT_BALANCE_MISSING");
      const updatedAt = isoFromMillis(row.updatedTime ?? row.updatedAt);
      return {
        value: {
          equity: finite(row.equity, "equity"),
          balance: row.balance == null ? undefined : finite(row.balance, "balance"),
          availableForTrade:
            row.availableForTrade == null
              ? undefined
              : finite(row.availableForTrade, "available_for_trade"),
          unrealizedPnl:
            row.unrealisedPnl == null && row.unrealizedPnl == null
              ? undefined
              : finite(row.unrealisedPnl ?? row.unrealizedPnl, "unrealized_pnl"),
          updatedAt,
        },
        sourceUpdatedAt: updatedAt,
        accountId: row.accountId == null ? undefined : String(row.accountId),
      };
    });
  }

  positions(market: string): Promise<SourceEvidence<StrictPosition[]>> {
    return this.read(
      "EXTENDED_REST_POSITIONS",
      () => this.exchange.strictReadPositions(market),
      (raw) => {
        const value = rows(raw).map((row) => {
          const rowMarket = String(row.market || "");
          if (!rowMarket) throw new Error("EXTENDED_STRICT_POSITION_MARKET_MISSING");
          const side = String(row.side || "").toUpperCase();
          if (side !== "LONG" && side !== "SHORT") {
            throw new Error("EXTENDED_STRICT_POSITION_SIDE_INVALID");
          }
          return {
            accountId: row.accountId == null ? undefined : String(row.accountId),
            market: rowMarket,
            size: finite(row.size ?? row.qty, "position_size"),
            side,
            markPrice:
              row.markPrice == null ? undefined : finite(row.markPrice, "position_mark_price", { positive: true }),
            openPrice:
              row.openPrice == null ? undefined : finite(row.openPrice, "position_open_price", { positive: true }),
            unrealizedPnl:
              row.unrealisedPnl == null && row.unrealizedPnl == null
                ? undefined
                : finite(row.unrealisedPnl ?? row.unrealizedPnl, "position_unrealized_pnl"),
            liquidationPrice:
              row.liquidationPrice == null
                ? undefined
                : finite(row.liquidationPrice, "position_liquidation_price", { positive: true }),
            updatedAt: isoFromMillis(row.updatedAt ?? row.updatedTime),
          } satisfies StrictPosition;
        });
        return {
          value,
          sourceUpdatedAt: latestTimestamp(value.map((row) => row.updatedAt)),
        };
      }
    );
  }

  openOrders(market: string): Promise<SourceEvidence<StrictOpenOrder[]>> {
    return this.read(
      "EXTENDED_REST_OPEN_ORDERS",
      () => this.exchange.strictReadOpenOrders(market),
      (raw) => {
        const value = rows(raw).map((row) => {
          const rowMarket = String(row.market || "");
          const id = row.externalId ?? row.id;
          if (!rowMarket || id == null) throw new Error("EXTENDED_STRICT_ORDER_IDENTITY_MISSING");
          const side = String(row.side || "").toUpperCase();
          if (side !== "BUY" && side !== "SELL") {
            throw new Error("EXTENDED_STRICT_ORDER_SIDE_INVALID");
          }
          return {
            accountId: row.accountId == null ? undefined : String(row.accountId),
            id: String(id),
            externalId: row.externalId == null ? undefined : String(row.externalId),
            market: rowMarket,
            side,
            price: finite(row.price, "order_price", { positive: true }),
            qty: finite(row.qty ?? row.size, "order_qty", { positive: true }),
            filledQty: finite(row.filledQty ?? 0, "order_filled_qty"),
            status: String(row.status || "NEW").toUpperCase(),
            updatedAt: isoFromMillis(row.updatedTime ?? row.updatedAt),
          } satisfies StrictOpenOrder;
        });
        return {
          value,
          sourceUpdatedAt: latestTimestamp(value.map((row) => row.updatedAt)),
        };
      }
    );
  }

  leverage(market: string): Promise<SourceEvidence<StrictLeverage>> {
    return this.read(
      "EXTENDED_REST_LEVERAGE",
      () => this.exchange.strictReadLeverage(market),
      (raw) => {
        const list = rows(raw);
        const row = list.find((candidate) => String(candidate.market || "") === market) ?? list[0];
        if (!row) throw new Error("EXTENDED_STRICT_LEVERAGE_MISSING");
        return {
          value: {
            market: String(row.market || market),
            leverage: finite(row.leverage ?? row.value ?? raw, "leverage", { positive: true }),
          },
          accountId: row.accountId == null ? undefined : String(row.accountId),
        };
      }
    );
  }

  markPrice(market: string): Promise<SourceEvidence<StrictMarkPrice>> {
    return this.read(
      "EXTENDED_MARK_PRICE",
      () => this.exchange.strictReadMarkPrice(market),
      (raw) => {
        const row = rows(raw)[0];
        if (!row) throw new Error("EXTENDED_STRICT_MARK_PRICE_MISSING");
        const updatedAt = isoFromMillis(row.updatedTime ?? row.updatedAt ?? row.ts);
        return {
          value: {
            market: String(row.market || market),
            markPrice: finite(row.markPrice, "mark_price"),
            updatedAt,
          },
          sourceUpdatedAt: updatedAt,
        };
      }
    );
  }
}
