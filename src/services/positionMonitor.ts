import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import { UserPositionInterface } from '../interfaces/User';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';

const PROXY_WALLET = ENV.PROXY_WALLET;
const USER_ADDRESSES = ENV.USER_ADDRESSES;
const MIN_ORDER_SIZE_TOKENS = 1.0;

const extractOrderError = (response: unknown): string | undefined => {
    if (!response) return undefined;
    if (typeof response === 'string') return response;
    if (typeof response === 'object') {
        const data = response as Record<string, unknown>;
        if (typeof data.error === 'string') return data.error;
        if (typeof data.errorMsg === 'string') return data.errorMsg;
        if (typeof data.message === 'string') return data.message;
    }
    return undefined;
};

const isFatalOrderError = (message: string | undefined): boolean => {
    if (!message) return false;
    const lower = message.toLowerCase();
    return (
        lower.includes('restricted') ||
        lower.includes('geoblock') ||
        lower.includes('forbidden') ||
        lower.includes('not authorized') ||
        lower.includes('unauthorized')
    );
};

/**
 * Find the earliest timestamp when we actually bought a given asset.
 * Searches all trader activity collections for BUY records with myBoughtSize > 0.
 */
const getEarliestBuyTimestamp = async (asset: string): Promise<number | null> => {
    let earliest: number | null = null;

    for (const address of USER_ADDRESSES) {
        const UserActivity = getUserActivityModel(address);
        const record = await UserActivity.findOne(
            {
                asset,
                side: 'BUY',
                bot: true,
                myBoughtSize: { $exists: true, $gt: 0 },
            },
            { timestamp: 1 }
        )
            .sort({ timestamp: 1 })
            .exec();

        if (record && record.timestamp) {
            if (earliest === null || record.timestamp < earliest) {
                earliest = record.timestamp;
            }
        }
    }

    return earliest;
};

/**
 * Sell an entire position at the best available bid using FOK market orders.
 * Mirrors the MERGE strategy in postOrder.ts.
 */
const sellEntirePosition = async (
    clobClient: ClobClient,
    position: UserPositionInterface,
    reason: string
): Promise<void> => {
    const RETRY_LIMIT = ENV.RETRY_LIMIT;
    let remaining = position.size;

    if (remaining < MIN_ORDER_SIZE_TOKENS) {
        Logger.warning(
            `[PositionMonitor] Position size ${remaining.toFixed(2)} tokens too small to sell — skipping`
        );
        return;
    }

    Logger.warning(
        `[PositionMonitor] ${reason} — selling ${remaining.toFixed(2)} tokens of ${position.slug || position.asset.slice(0, 8)}...`
    );

    let retry = 0;
    while (remaining >= MIN_ORDER_SIZE_TOKENS && retry < RETRY_LIMIT) {
        const orderBook = await clobClient.getOrderBook(position.asset);
        if (!orderBook.bids || orderBook.bids.length === 0) {
            Logger.warning('[PositionMonitor] No bids available in order book — aborting exit');
            break;
        }

        const bestBid = orderBook.bids.reduce((max, bid) => {
            return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
        }, orderBook.bids[0]);

        const sellAmount = Math.min(remaining, parseFloat(bestBid.size));

        if (sellAmount < MIN_ORDER_SIZE_TOKENS) {
            Logger.info('[PositionMonitor] Remaining below minimum — exit complete');
            break;
        }

        const orderArgs = {
            side: Side.SELL,
            tokenID: position.asset,
            amount: sellAmount,
            price: parseFloat(bestBid.price),
        };

        const signedOrder = await clobClient.createMarketOrder(orderArgs);
        const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

        if (resp.success === true) {
            retry = 0;
            remaining -= sellAmount;
            Logger.orderResult(
                true,
                `[PositionMonitor] Sold ${sellAmount.toFixed(2)} tokens @ $${bestBid.price} (${reason})`
            );
        } else {
            const errorMessage = extractOrderError(resp);
            if (isFatalOrderError(errorMessage)) {
                Logger.error(
                    `[PositionMonitor] Fatal error during exit sell: ${errorMessage}`
                );
                break;
            }
            retry += 1;
            Logger.warning(
                `[PositionMonitor] Sell attempt ${retry}/${RETRY_LIMIT} failed${errorMessage ? ` — ${errorMessage}` : ''}`
            );
        }
    }

    if (remaining < MIN_ORDER_SIZE_TOKENS || remaining <= 0) {
        Logger.success(
            `[PositionMonitor] Exit complete for ${position.slug || position.asset.slice(0, 8)} (${reason})`
        );
    } else {
        Logger.warning(
            `[PositionMonitor] Exit incomplete — ${remaining.toFixed(2)} tokens remain for ${position.slug || position.asset.slice(0, 8)}`
        );
    }
};

/**
 * Check all bot positions for stop-loss and time-exit conditions.
 */
const checkPositionExits = async (clobClient: ClobClient): Promise<void> => {
    const stopLossEnabled = ENV.STOP_LOSS_ENABLED;
    const stopLossPercent = ENV.STOP_LOSS_PERCENT;
    const timeExitEnabled = ENV.TIME_EXIT_ENABLED;
    const timeExitDays = ENV.TIME_EXIT_DAYS;

    let positions: UserPositionInterface[];
    try {
        positions = await fetchData(
            `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
        );
    } catch (err) {
        Logger.error(`[PositionMonitor] Failed to fetch positions: ${err}`);
        return;
    }

    if (!Array.isArray(positions) || positions.length === 0) {
        return;
    }

    for (const position of positions) {
        // Skip redeemable/resolved positions — handled by closeResolvedPositions script
        if (position.redeemable) continue;

        const avgPrice = position.avgPrice;
        const curPrice = position.curPrice;

        if (!avgPrice || avgPrice <= 0) continue;

        // --- Stop-loss check ---
        if (stopLossEnabled) {
            const stopLevel = avgPrice * (1 - stopLossPercent / 100);
            if (curPrice <= stopLevel) {
                Logger.warning(
                    `[PositionMonitor] Stop-loss triggered: ${position.slug || position.asset.slice(0, 8)} — curPrice $${curPrice.toFixed(4)} <= stop $${stopLevel.toFixed(4)} (entry $${avgPrice.toFixed(4)})`
                );
                // Re-fetch live position to confirm it still exists before selling
                const livePositions: UserPositionInterface[] = await fetchData(
                    `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
                );
                const livePosition = livePositions.find((p) => p.asset === position.asset);
                if (!livePosition || livePosition.size < MIN_ORDER_SIZE_TOKENS) {
                    Logger.info(
                        `[PositionMonitor] Position already closed or too small — skipping stop-loss sell`
                    );
                    continue;
                }
                await sellEntirePosition(clobClient, livePosition, `STOP_LOSS (${stopLossPercent}%)`);
                continue;
            }
        }

        // --- Time exit check ---
        if (timeExitEnabled) {
            const entryTimestamp = await getEarliestBuyTimestamp(position.asset);
            if (entryTimestamp !== null) {
                // Polymarket timestamps are in seconds; convert to ms for comparison
                const entryMs =
                    entryTimestamp > 1e12 ? entryTimestamp : entryTimestamp * 1000;
                const heldDays = (Date.now() - entryMs) / (86400 * 1000);

                if (heldDays >= timeExitDays) {
                    Logger.warning(
                        `[PositionMonitor] Time exit triggered: ${position.slug || position.asset.slice(0, 8)} — held ${heldDays.toFixed(1)} days >= ${timeExitDays} day limit`
                    );
                    // Re-fetch live position to confirm it still exists
                    const livePositions: UserPositionInterface[] = await fetchData(
                        `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
                    );
                    const livePosition = livePositions.find((p) => p.asset === position.asset);
                    if (!livePosition || livePosition.size < MIN_ORDER_SIZE_TOKENS) {
                        Logger.info(
                            `[PositionMonitor] Position already closed or too small — skipping time exit sell`
                        );
                        continue;
                    }
                    await sellEntirePosition(clobClient, livePosition, `TIME_EXIT (${heldDays.toFixed(0)}d)`);
                    continue;
                }
            }
        }
    }
};

let isRunning = true;

export const stopPositionMonitor = () => {
    isRunning = false;
    Logger.info('Position monitor shutdown requested...');
};

const positionMonitor = async (clobClient: ClobClient): Promise<void> => {
    const intervalSeconds = ENV.POSITION_CHECK_INTERVAL_SECONDS;
    const stopLossEnabled = ENV.STOP_LOSS_ENABLED;
    const timeExitEnabled = ENV.TIME_EXIT_ENABLED;

    Logger.success(
        `Position monitor active — checking every ${intervalSeconds}s` +
            (stopLossEnabled ? ` | Stop-loss: ${ENV.STOP_LOSS_PERCENT}%` : '') +
            (timeExitEnabled ? ` | Time exit: ${ENV.TIME_EXIT_DAYS}d` : '')
    );

    while (isRunning) {
        await checkPositionExits(clobClient);
        if (!isRunning) break;
        await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
    }

    Logger.info('Position monitor stopped');
};

export default positionMonitor;
