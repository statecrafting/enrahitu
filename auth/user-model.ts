/**
 * User-account data access on CoreLedger. The template's single Postgres
 * upsert becomes a find-then-write inside one ledger transaction; emails are
 * normalized to lowercase here so UNIQUE(email) is case-insensitive in
 * practice.
 */
import { UserAccount } from "./entities";
import { dbReady, ledger } from "./store";
import type { SSOProfile } from "./types";

export async function upsertUserFromProfile(profile: SSOProfile): Promise<UserAccount> {
  await dbReady;
  const email = profile.email.trim().toLowerCase();
  const now = new Date();
  return ledger().transaction(async ({ repo }) => {
    const users = repo(UserAccount);
    const existing = await users.findOne({ email } as Partial<UserAccount>);
    if (existing) {
      await users.updateById(existing.id, {
        name: profile.name,
        roles: profile.roles,
        ssoProvider: profile.ssoProvider,
        ssoProviderId: profile.ssoProviderId,
        attributes: profile.attributes ?? {},
        lastLoginAt: now,
        updatedAt: now,
      });
      return (await users.findById(existing.id))!;
    }
    const user = Object.assign(new UserAccount(), {
      email,
      name: profile.name,
      roles: profile.roles,
      ssoProvider: profile.ssoProvider,
      ssoProviderId: profile.ssoProviderId,
      attributes: profile.attributes ?? {},
      lastLoginAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await users.insert(user);
    return user;
  });
}

export async function getUserById(id: string): Promise<UserAccount | null> {
  await dbReady;
  return ledger().repo(UserAccount).findById(id);
}
