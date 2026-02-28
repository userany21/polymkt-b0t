import { ethers } from 'ethers';
import { AssetType, ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const RPC_URL = ENV.RPC_URL;

const RESOLVED_HIGH = 0.99;
const ZERO_THRESHOLD = 0.0001;
const MIN_SELL_TOKENS = 1.0;

const CTF_CONTRACT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
];

interface WinPosition {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    currentValue: number;
    curPrice: number;
    title?: string;
    outcome?: string;
    slug?: string;
    redeemable?: boolean;
}

// Track conditions already redeemed this session to avoid double-redeeming
const redeemedConditions = new Set<string>();

let isRunning = true;

export const stopWinRedeemer = () => {
    isRunning = false;
    Logger.info('[WinRedeemer] Shutdown requested...');
};

const updatePolymarketCache = async (clobClient: ClobClient, tokenId: string): Promise<void> => {
    try {
        await clobClient.updateBalanceAllowance({
            asset_type: AssetType.CONDITIONAL,
            token_id: tokenId,
        });
    } catch {
        // non-fatal — ignore cache refresh failures
    }
};

const closeSinglePosition = async (
    clobClient: ClobClient,
    position: WinPosition
): Promise<void> => {
    const RETRY_LIMIT = ENV.RETRY_LIMIT;
    let remaining = position.size;
    const label = position.title || position.slug || position.asset.slice(0, 10);

    if (remaining < MIN_SELL_TOKENS) {
        Logger.info(
            `[WinRedeemer] ${label} size ${remaining.toFixed(4)} < ${MIN_SELL_TOKENS} min — skipping CLOB close`
        );
        return;
    }

    await updatePolymarketCache(clobClient, position.asset);

    let attempts = 0;
    while (remaining >= MIN_SELL_TOKENS && attempts < RETRY_LIMIT) {
        const orderBook = await clobClient.getOrderBook(position.asset);

        if (!orderBook.bids || orderBook.bids.length === 0) {
            Logger.warning(`[WinRedeemer] No bids for ${label} — cannot close on CLOB`);
            break;
        }

        const bestBid = orderBook.bids.reduce(
            (max: { price: string; size: string }, bid: { price: string; size: string }) =>
                parseFloat(bid.price) > parseFloat(max.price) ? bid : max,
            orderBook.bids[0]
        );

        const bidSize = parseFloat(bestBid.size);
        const bidPrice = parseFloat(bestBid.price);

        if (bidSize < MIN_SELL_TOKENS) {
            Logger.warning(
                `[WinRedeemer] Best bid size ${bidSize.toFixed(2)} < ${MIN_SELL_TOKENS} for ${label} — skipping`
            );
            break;
        }

        const sellAmount = Math.min(remaining, bidSize);
        if (sellAmount < MIN_SELL_TOKENS) break;

        try {
            const signedOrder = await clobClient.createMarketOrder({
                side: Side.SELL,
                tokenID: position.asset,
                amount: sellAmount,
                price: bidPrice,
            });
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success === true) {
                remaining -= sellAmount;
                attempts = 0;
                Logger.orderResult(
                    true,
                    `[WinRedeemer] Sold ${sellAmount.toFixed(2)} tokens @ $${bidPrice.toFixed(3)} — ${label}`
                );
            } else {
                attempts++;
                const respObj = resp as Record<string, unknown>;
                const errorMsg =
                    (respObj.error as string) ||
                    (respObj.errorMsg as string) ||
                    (respObj.message as string) ||
                    undefined;
                Logger.warning(
                    `[WinRedeemer] Sell attempt ${attempts}/${RETRY_LIMIT} failed${errorMsg ? ` — ${errorMsg}` : ''}`
                );
            }
        } catch (error) {
            attempts++;
            Logger.warning(
                `[WinRedeemer] Sell attempt ${attempts}/${RETRY_LIMIT} threw error: ${error}`
            );
        }
    }
};

const redeemSingleCondition = async (
    ctfContract: ethers.Contract,
    conditionId: string,
    positions: WinPosition[]
): Promise<boolean> => {
    try {
        const conditionIdBytes32 = ethers.utils.hexZeroPad(
            ethers.BigNumber.from(conditionId).toHexString(),
            32
        );
        const parentCollectionId = ethers.constants.HashZero;
        const indexSets = [1, 2];

        const feeData = await ctfContract.provider.getFeeData();
        const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
        if (!gasPrice) throw new Error('Could not determine gas price');

        const adjustedGasPrice = (gasPrice as ethers.BigNumber).mul(120).div(100);

        const label = positions[0].title || positions[0].slug || conditionId.slice(0, 12);
        const totalValue = positions.reduce((sum, p) => sum + p.currentValue, 0);

        Logger.info(
            `[WinRedeemer] Submitting redemption for "${label}" (~$${totalValue.toFixed(2)})...`
        );

        const tx = await ctfContract.redeemPositions(
            USDC_ADDRESS,
            parentCollectionId,
            conditionIdBytes32,
            indexSets,
            { gasLimit: 500000, gasPrice: adjustedGasPrice }
        );

        Logger.info(`[WinRedeemer] TX submitted: ${tx.hash} — waiting for confirmation...`);
        const receipt = await tx.wait();

        if (receipt.status === 1) {
            Logger.success(
                `[WinRedeemer] Redeemed! ~$${totalValue.toFixed(2)} USDC recovered. Gas used: ${receipt.gasUsed.toString()}`
            );
            return true;
        } else {
            Logger.error('[WinRedeemer] Redemption transaction reverted on-chain');
            return false;
        }
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        Logger.error(`[WinRedeemer] Redemption failed: ${msg}`);
        return false;
    }
};

const checkAndAutoRedeem = async (clobClient: ClobClient): Promise<void> => {
    let allPositions: WinPosition[];

    try {
        allPositions = await fetchData(
            `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
        );
    } catch (err) {
        Logger.error(`[WinRedeemer] Failed to fetch positions: ${err}`);
        return;
    }

    if (!Array.isArray(allPositions) || allPositions.length === 0) return;

    const winningPositions = allPositions.filter(
        (p) => p.curPrice >= RESOLVED_HIGH && (p.size || 0) > ZERO_THRESHOLD
    );

    if (winningPositions.length === 0) return;

    Logger.success(
        `[WinRedeemer] Found ${winningPositions.length} winning position(s)! Auto-processing...`
    );

    // Positions where the market resolved on-chain (redeemable via CTF contract)
    const toRedeemOnChain = winningPositions.filter((p) => p.redeemable === true);
    // Positions where the market has resolved in price but not yet on-chain (sell via CLOB)
    const toCloseOnClob = winningPositions.filter((p) => !p.redeemable);

    // Step 1: Close non-redeemable winners on the CLOB orderbook
    if (toCloseOnClob.length > 0) {
        Logger.info(
            `[WinRedeemer] Closing ${toCloseOnClob.length} position(s) via CLOB...`
        );
        for (const pos of toCloseOnClob) {
            const label = pos.title || pos.slug || pos.asset.slice(0, 10);
            Logger.info(
                `[WinRedeemer] CLOB close: ${label} | ${pos.size.toFixed(2)} tokens @ $${pos.curPrice.toFixed(4)}`
            );
            await closeSinglePosition(clobClient, pos);
        }
    }

    // Step 2: Redeem on-chain winners grouped by conditionId
    if (toRedeemOnChain.length > 0) {
        const newToRedeem = toRedeemOnChain.filter(
            (p) => !redeemedConditions.has(p.conditionId)
        );

        if (newToRedeem.length === 0) {
            Logger.info('[WinRedeemer] All redeemable conditions already processed this session');
            return;
        }

        Logger.info(
            `[WinRedeemer] Redeeming ${newToRedeem.length} position(s) on-chain via CTF contract...`
        );

        const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        const ctfContract = new ethers.Contract(CTF_CONTRACT_ADDRESS, CTF_ABI, wallet);

        // Group by conditionId to redeem each condition once
        const byCondition = new Map<string, WinPosition[]>();
        newToRedeem.forEach((pos) => {
            const existing = byCondition.get(pos.conditionId) || [];
            existing.push(pos);
            byCondition.set(pos.conditionId, existing);
        });

        Logger.info(
            `[WinRedeemer] Grouped into ${byCondition.size} unique condition(s)`
        );

        let conditionIdx = 0;
        for (const [conditionId, positions] of byCondition.entries()) {
            conditionIdx++;
            Logger.info(
                `[WinRedeemer] Processing condition ${conditionIdx}/${byCondition.size}`
            );

            const success = await redeemSingleCondition(ctfContract, conditionId, positions);
            if (success) {
                redeemedConditions.add(conditionId);
            }

            // Small delay between consecutive on-chain transactions
            if (conditionIdx < byCondition.size) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
        }
    }
};

const winRedeemer = async (clobClient: ClobClient): Promise<void> => {
    const intervalSeconds = ENV.WIN_CHECK_INTERVAL_SECONDS;

    Logger.success(
        `[WinRedeemer] Active — polling every ${intervalSeconds}s for winning positions (price >= $${RESOLVED_HIGH})`
    );

    while (isRunning) {
        await checkAndAutoRedeem(clobClient);
        if (!isRunning) break;
        await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
    }

    Logger.info('[WinRedeemer] Stopped');
};

export default winRedeemer;
