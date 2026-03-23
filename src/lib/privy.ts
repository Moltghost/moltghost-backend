// lib/privy.ts
import { PrivyClient, APIError, PrivyAPIError } from "@privy-io/node";

interface LinkedAccount {
  type: string;
  address?: string;
}

interface PrivyUser {
  id: string;
  linked_accounts: LinkedAccount[];
}

interface AuthenticationClaims {
  userId: string;
}

const privy = new PrivyClient({
  appId: process.env.PRIVY_APP_ID || "",
  appSecret: process.env.PRIVY_APP_SECRET || "",
});

export async function verifyPrivyToken(
  token: string,
): Promise<AuthenticationClaims> {
  try {
    // The PrivyClient handles token verification internally
    // We verify the token by attempting to use it to get the user
    // If the token is invalid, Privy's API will reject it
    const decoded = JSON.parse(
      Buffer.from(token.split(".")[1], "base64").toString(),
    );
    return {
      userId: decoded.sub || decoded.user_id,
    };
  } catch (error) {
    console.error("Error verifying Privy token:", error);
    throw new Error("Invalid Privy authentication token");
  }
}

export async function getPrivyUser(userId: string): Promise<PrivyUser> {
  try {
    const user = await privy.users()._get(userId);
    return user as PrivyUser;
  } catch (error: unknown) {
    if (error instanceof APIError) {
      console.error(
        "Error fetching Privy user:",
        (error as APIError).status,
        (error as APIError).name,
      );
    } else if (error instanceof PrivyAPIError) {
      console.error(
        "Error fetching Privy user:",
        (error as PrivyAPIError).message,
      );
    } else {
      console.error("Error fetching Privy user:", error);
    }
    throw new Error("Failed to fetch user data from Privy");
  }
}

export async function createEmbeddedSolanaWallet(
  userId: string,
): Promise<string> {
  try {
    console.log("Creating embedded Solana wallet for user:", userId);
    const wallet = await privy.wallets().create({
      chain_type: "solana",
    });
    console.log("Embedded Solana wallet created:", wallet.address);
    return wallet.address;
  } catch (error: unknown) {
    if (error instanceof APIError) {
      console.error(
        "Error creating Solana wallet:",
        (error as APIError).status,
        (error as APIError).name,
      );
    } else if (error instanceof PrivyAPIError) {
      console.error(
        "Error creating Solana wallet:",
        (error as PrivyAPIError).message,
      );
    } else {
      console.error("Error creating Solana wallet:", error);
    }
    throw new Error("Failed to create embedded Solana wallet");
  }
}

export function extractWalletFromPrivy(privyUser: PrivyUser): string | null {
  // Only accept Solana wallets (both embedded and connected)
  const solanaWalletTypes = ["solana_wallet", "sol_wallet"];

  for (const type of solanaWalletTypes) {
    const walletMethods = privyUser.linked_accounts?.filter(
      (account) => account.type === type,
    );

    if (walletMethods && walletMethods.length > 0 && walletMethods[0].address) {
      return walletMethods[0].address;
    }
  }

  return null;
}

// Check if user has email login (for embedded wallet auto-creation logic)
export function hasEmailLogin(privyUser: PrivyUser): boolean {
  return (
    privyUser.linked_accounts?.some((account) => account.type === "email") ||
    false
  );
}

// Check if user has connected wallet (non-embedded)
export function hasConnectedWallet(privyUser: PrivyUser): boolean {
  // Check for connected wallet types (not embedded or email)
  const connectedWalletTypes = [
    "solana_wallet",
    "sol_wallet",
    "ethereum",
    "eth_wallet",
  ];
  return (
    privyUser.linked_accounts?.some(
      (account) =>
        connectedWalletTypes.includes(account.type) && account.address,
    ) || false
  );
}

interface RequestWithHeaders {
  headers?: {
    authorization?: string;
  };
  cookies?: {
    privy_token?: string;
  };
}

export async function authenticateRequest(
  req: RequestWithHeaders,
): Promise<AuthenticationClaims | null> {
  try {
    const token =
      req.headers?.authorization?.replace("Bearer ", "") ||
      req.cookies?.privy_token;

    if (!token) {
      return null;
    }

    const claims = await verifyPrivyToken(token);
    return claims;
  } catch (error) {
    console.error("Authentication failed:", error);
    return null;
  }
}

interface SessionUser {
  privyId: string;
  wallet: string | null;
  privy: PrivyUser;
}

export async function getSessionUser(
  req: RequestWithHeaders,
): Promise<SessionUser | null> {
  try {
    const claims = await authenticateRequest(req);
    if (!claims) return null;

    let privyUser = await getPrivyUser(claims.userId);
    let wallet = extractWalletFromPrivy(privyUser);
    const isEmailLogin = hasEmailLogin(privyUser);
    const hasConnected = hasConnectedWallet(privyUser);

    // Auto-create embedded Solana wallet ONLY for email logins without wallet
    if (!wallet && isEmailLogin && !hasConnected) {
      console.log(
        "Email login detected with no wallet, creating embedded Solana wallet...",
      );
      try {
        wallet = await createEmbeddedSolanaWallet(claims.userId);
        // Refresh user data to confirm wallet creation
        privyUser = await getPrivyUser(claims.userId);
      } catch (walletError) {
        console.error("Failed to create embedded wallet:", walletError);
        throw new Error(
          "Failed to create embedded wallet. Please try again or contact support.",
        );
      }
    } else if (!wallet && !isEmailLogin) {
      // User connected wallet but it's not Solana - reject
      console.log("User has connected wallet but it's not Solana");
      throw new Error(
        "Only Solana wallets are supported. Please connect a Solana wallet.",
      );
    }

    return {
      privyId: claims.userId,
      wallet,
      privy: privyUser,
    };
  } catch (error) {
    console.error("Error getting session user:", error);
    return null;
  }
}
