import { indexer } from "envio";
import { tokenId, userId, isolationVaultLookupId } from "./helpers/ids";
import { createUserIfNecessary } from "./helpers/user";

// Ported from isolation-mode-vaults.handleVaultCreated. Emitted by an
// IsolationModeFactory (dynamic contract). Creates the vault<->owner reverse
// lookup and rebinds the vault User's effectiveUser to the owner account.
indexer.onEvent(
  { contract: "IsolationModeFactory", event: "VaultCreated" },
  async ({ event, context }) => {
    const chainId = event.chainId;

    const token = await context.Token.getOrThrow(tokenId(chainId, event.srcAddress));

    await createUserIfNecessary(context, chainId, event.params.vault);
    await createUserIfNecessary(context, chainId, event.params.account);

    const vaultUser = await context.User.getOrThrow(userId(chainId, event.params.vault));
    context.User.set({
      ...vaultUser,
      effectiveUser_id: userId(chainId, event.params.account),
      isEffectiveUser: false,
      isolationModeVault_id: token.id,
    });

    context.IsolationModeVaultReverseLookup.set({
      id: isolationVaultLookupId(chainId, event.params.vault),
      token_id: token.id,
      vault_id: userId(chainId, event.params.vault),
      owner_id: userId(chainId, event.params.account),
    });
  }
);
