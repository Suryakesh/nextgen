import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, handleOptions } from "@/lib/cors";
import prisma from "@/lib/prisma";
import { ethers } from "ethers";
import { logAuditEvent } from "@/lib/audit";

const MINIMAL_ABI = [
  "function mintCredit(address to, string memory uri) external returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

export const maxDuration = 60;

export async function OPTIONS(request: Request) {
  return handleOptions(request);
}

export async function POST(
  req: NextRequest,
  { params }: { params: { submissionId: string } }
) {
  const { submissionId } = params;
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);

  // Tracked outside the try block so the outer catch can tell whether a real
  // mint attempt was already logged (and therefore needs a matching
  // "mint_failed" entry) versus a failure that happened before any attempt
  // (e.g. submission not found, insufficient balance) which has nothing to
  // pair it with.
  let mintAttemptLogged = false;

  try {
    // 1. Load Submission by submissionId (including user and credit relations)
    const submission = await prisma.submission.findUnique({
      where: { id: submissionId },
      include: {
        user: true,
        credit: true,
      },
    });

    if (!submission) {
      console.error(`[mint] rejected: submission '${submissionId}' not found`);
      return NextResponse.json(
        { error: `Submission '${submissionId}' not found.` },
        { status: 404, headers }
      );
    }

    // 2. Return 400 if submission status is not "verified"
    if (submission.status !== "verified") {
      console.error(
        `[mint] rejected: submission '${submissionId}' has status '${submission.status}', not 'verified'`
      );
      return NextResponse.json(
        {
          error: `Submission '${submissionId}' cannot be minted because its status is '${submission.status}' (must be 'verified').`,
        },
        { status: 400, headers }
      );
    }

    // 3. Idempotent double-mint protection: a recorded tx_hash means minting was
    // already submitted for this submission (possibly still unconfirmed — see
    // below), so never call mintCredit() again. token_id is null until tx.wait()
    // resolves and the Transfer event is parsed, so its nullness is the only
    // signal we have for "submitted but not yet confirmed" (no separate status
    // field on Credit).
    if (submission.credit?.tx_hash) {
      console.log(
        `[mint] submission '${submissionId}' already has tx_hash ${submission.credit.tx_hash} ` +
          `(token_id=${submission.credit.token_id ?? "pending"}); returning existing record instead of minting again`
      );
      const explorer_url = `https://amoy.polygonscan.com/tx/${submission.credit.tx_hash}`;

      return NextResponse.json(
        {
          token_id: submission.credit.token_id,
          tx_hash: submission.credit.tx_hash,
          explorer_url,
        },
        { status: 200, headers }
      );
    }

    // Check environment variables
    const rpcUrl = process.env.ALCHEMY_RPC_URL;
    const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
    const contractAddress = process.env.CONTRACT_ADDRESS;

    if (!rpcUrl || !privateKey || !contractAddress) {
      console.error("[mint] failed: blockchain configuration (RPC URL, private key, or contract address) missing in environment");
      return NextResponse.json(
        { error: "Server blockchain configuration missing in environment." },
        { status: 500, headers }
      );
    }

    // 4. Server-side wallet setup
    const formattedPrivateKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    // Pinning the network (80002 = Polygon Amoy, matching hardhat.config.ts)
    // skips ethers' implicit network-detection call, and batchMaxCount: 1
    // stops that detection call from being batched with the getBalance call
    // below — Alchemy rejects batched JSON-RPC requests on this endpoint.
    const provider = new ethers.JsonRpcProvider(rpcUrl, 80002, {
      staticNetwork: true,
      batchMaxCount: 1,
    });
    const wallet = new ethers.Wallet(formattedPrivateKey, provider);

    // Fail early if deployer balance is too low (< 0.001 MATIC)
    const balance = await provider.getBalance(wallet.address);
    if (balance < ethers.parseEther("0.001")) {
      console.error(
        `[mint] failed: deployer wallet '${wallet.address}' has insufficient funds (${ethers.formatEther(balance)} MATIC)`
      );
      return NextResponse.json(
        {
          error: `Deployer wallet '${wallet.address}' has insufficient funds (${ethers.formatEther(balance)} MATIC) to cover minting gas fees.`,
        },
        { status: 500, headers }
      );
    }

    const contract = new ethers.Contract(contractAddress, MINIMAL_ABI, wallet);

    // Log the attempt right before the on-chain call — the idempotent
    // double-mint short-circuit above returns before this point, so it never
    // produces a spurious "attempted" entry.
    await logAuditEvent({
      submissionId: submission.id,
      action: "mint_attempted",
      actor: "system",
    });
    mintAttemptLogged = true;

    // Call mintCredit(address to, string uri)
    const tx = await contract.mintCredit(submission.user.wallet_address, submission.photo_url);

    // 5. Persist the tx hash BEFORE awaiting confirmation. If the invocation
    // dies during tx.wait() below, the transaction may still succeed on-chain;
    // recording the hash now means the idempotency check above will pick it
    // up on retry instead of minting a second credit for this submission.
    try {
      await prisma.credit.upsert({
        where: { submission_id: submission.id },
        update: { tx_hash: tx.hash },
        create: { submission_id: submission.id, tx_hash: tx.hash },
      });
    } catch (persistErr: any) {
      console.error(
        `[mint] CRITICAL: tx ${tx.hash} submitted on-chain for submission '${submissionId}' but failed to persist ` +
          `before confirmation: ${persistErr.message || String(persistErr)}`
      );
    }

    // 6. Wait for block confirmation
    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {
      console.error(`[mint] failed: tx ${tx.hash} reverted or failed on-chain for submission '${submissionId}'`);
      // The mint never actually completed, so remove the pending row rather
      // than leaving a permanently-unconfirmable tx_hash blocking future retries.
      try {
        await prisma.credit.delete({ where: { submission_id: submission.id } });
      } catch (deleteErr: any) {
        console.error(
          `[mint] failed to clean up pending credit row for submission '${submissionId}' after on-chain failure: ` +
            `${deleteErr.message || String(deleteErr)}`
        );
      }
      await logAuditEvent({
        submissionId: submission.id,
        action: "mint_failed",
        actor: "system",
        detail: { error: "Mint transaction failed or reverted on-chain.", tx_hash: tx.hash },
      });
      return NextResponse.json(
        { error: "Mint transaction failed or reverted on-chain." },
        { status: 500, headers }
      );
    }

    // Parse Transfer event for token_id
    let tokenIdStr: string | null = null;
    for (const log of receipt.logs) {
      try {
        const parsedLog = contract.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (parsedLog && parsedLog.name === "Transfer") {
          tokenIdStr = parsedLog.args.tokenId.toString();
          break;
        }
      } catch (e) {
        // Continue searching
      }
    }

    if (!tokenIdStr) {
      for (const log of receipt.logs) {
        if (log.topics[0] === ethers.id("Transfer(address,address,uint256)")) {
          tokenIdStr = BigInt(log.topics[3]).toString();
          break;
        }
      }
    }

    if (!tokenIdStr) {
      console.error(
        `[mint] failed: could not parse token ID from receipt for confirmed tx ${tx.hash} (submission '${submissionId}')`
      );
      await logAuditEvent({
        submissionId: submission.id,
        action: "mint_failed",
        actor: "system",
        detail: { error: "Could not parse token ID from mint transaction receipt.", tx_hash: tx.hash },
      });
      return NextResponse.json(
        { error: "Could not parse token ID from mint transaction receipt." },
        { status: 500, headers }
      );
    }

    // 7. Mark the credit confirmed now that we have the token_id.
    let credit;
    try {
      credit = await prisma.credit.upsert({
        where: { submission_id: submission.id },
        update: { token_id: tokenIdStr, tx_hash: receipt.hash },
        create: { submission_id: submission.id, token_id: tokenIdStr, tx_hash: receipt.hash },
      });
    } catch (persistErr: any) {
      console.error(
        `[mint] CRITICAL: tx ${receipt.hash} confirmed on-chain with token_id ${tokenIdStr} for submission ` +
          `'${submissionId}' but failed to persist token_id: ${persistErr.message || String(persistErr)}`
      );
      await logAuditEvent({
        submissionId: submission.id,
        action: "mint_failed",
        actor: "system",
        detail: {
          error: `Mint confirmed on-chain but failed to save to the database: ${persistErr.message || String(persistErr)}`,
          tx_hash: receipt.hash,
          token_id: tokenIdStr,
        },
      });
      return NextResponse.json(
        {
          error: `Mint confirmed on-chain (tx ${receipt.hash}, token ${tokenIdStr}) but failed to save to the database.`,
        },
        { status: 500, headers }
      );
    }

    const explorer_url = `https://amoy.polygonscan.com/tx/${receipt.hash}`;

    // 8. Log the audit trail entry (non-critical — never blocks the response)
    await logAuditEvent({
      submissionId: submission.id,
      action: "mint_succeeded",
      actor: "system",
      detail: { tx_hash: credit.tx_hash, token_id: credit.token_id },
    });

    // 9. Return 200 JSON
    return NextResponse.json(
      {
        token_id: credit.token_id,
        tx_hash: credit.tx_hash,
        explorer_url,
      },
      { status: 200, headers }
    );
  } catch (error: any) {
    console.error("[mint] failed: unexpected error", error);
    if (mintAttemptLogged) {
      await logAuditEvent({
        submissionId,
        action: "mint_failed",
        actor: "system",
        detail: { error: error?.message || String(error) },
      });
    }
    return NextResponse.json(
      { error: error?.message || "Internal server error during minting." },
      { status: 500, headers }
    );
  }
}
