import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase, teardown } from "./helpers/db";
import {
  createOrganization,
  getOrCreateDefaultOrganization,
  renameOrganization,
} from "@/lib/db/repositories";

/**
 * The organization the web dashboard operates on — there is no login to
 * derive it from, so "the one organization" has to come from somewhere
 * deterministic and idempotent.
 */
describe("getOrCreateDefaultOrganization", () => {
  beforeEach(async () => {
    await freshDatabase();
  });
  afterEach(teardown);

  it("creates one on first call when none exists", async () => {
    const org = await getOrCreateDefaultOrganization();
    expect(org.name).toBe("My Agency");
    expect(org.id).toBeTruthy();
  });

  it("returns the same row on every later call", async () => {
    const first = await getOrCreateDefaultOrganization();
    const second = await getOrCreateDefaultOrganization();
    const third = await getOrCreateDefaultOrganization();

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
  });

  it("does not create a second one when an organization already exists", async () => {
    // Simulates the Slack-first case: a workspace was installed before
    // anyone ever opened the dashboard.
    const existing = await createOrganization("Northlight Studio");
    const resolved = await getOrCreateDefaultOrganization();

    expect(resolved.id).toBe(existing.id);
    expect(resolved.name).toBe("Northlight Studio");
  });

  it("always resolves to the oldest organization, not the most recently created", async () => {
    const oldest = await createOrganization("First Agency");
    await createOrganization("Second Agency");

    expect((await getOrCreateDefaultOrganization()).id).toBe(oldest.id);
  });
});

describe("renameOrganization", () => {
  beforeEach(async () => {
    await freshDatabase();
  });
  afterEach(teardown);

  it("updates the name and returns the updated row", async () => {
    const org = await createOrganization("Old Name");
    const renamed = await renameOrganization(org.id, "New Name");

    expect(renamed!.id).toBe(org.id);
    expect(renamed!.name).toBe("New Name");
  });

  it("returns undefined for an id that does not exist", async () => {
    expect(await renameOrganization("00000000-0000-0000-0000-000000000000", "x")).toBeUndefined();
  });
});
