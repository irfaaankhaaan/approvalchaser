import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgency, harness, hours, teardown } from "./helpers/db";
import { createApproval } from "@/lib/approvals/service";
import { countApprovals, listApprovals } from "@/lib/db/repositories";
import {
  LIST_PAGE_SIZE,
  decodeListPage,
  encodeListPage,
  listBlocks,
} from "@/lib/slack/blocks";
import { OPEN_LIST_STATUSES, RECENT_LIST_STATUSES } from "@/lib/slack/list-statuses";

/**
 * Pagination has to carry its own mode and status set — this is the fix for
 * a bug where clicking "Next" on `/approval remind` silently dropped back to
 * the default overflow-menu list, and `list all`'s second page silently
 * dropped approved items.
 */
describe("list pagination round-trips its mode and status set", () => {
  it("encodes and decodes every combination", () => {
    for (const mode of ["default", "remind", "cancel"] as const) {
      for (const showAll of [true, false]) {
        for (const page of [0, 1, 7]) {
          expect(decodeListPage(encodeListPage(page, mode, showAll))).toEqual({
            page,
            mode,
            showAll,
          });
        }
      }
    }
  });

  it("falls back to page 0, default mode on a malformed value", () => {
    expect(decodeListPage(undefined)).toEqual({ page: 0, mode: "default", showAll: false });
    expect(decodeListPage("garbage")).toEqual({ page: 0, mode: "default", showAll: false });
    expect(decodeListPage("")).toEqual({ page: 0, mode: "default", showAll: false });
  });

  it("never lets a negative page through", () => {
    expect(decodeListPage("-3:remind:open").page).toBe(0);
  });
});

describe("listBlocks pagination buttons", () => {
  let agency: Awaited<ReturnType<typeof createAgency>>;

  beforeEach(async () => {
    await harness();
    agency = await createAgency();
    // One more than a full page, so a "Next" button actually appears.
    for (let i = 0; i < LIST_PAGE_SIZE + 2; i += 1) {
      await createApproval({
        organizationId: agency.organization.id,
        clientName: `Client ${i}`,
        clientEmail: `client${i}@example.com`,
        creativeName: `Creative ${i}`,
        deadline: new Date(Date.now() + hours(48)),
        reminderOffsets: [120],
      });
    }
  });
  afterEach(teardown);

  function findButton(blocks: unknown[], label: string) {
    for (const block of blocks as { type: string; elements?: { text?: { text?: string }; value?: string }[] }[]) {
      if (block.type !== "actions") continue;
      const match = block.elements?.find((e) => e.text?.text === label);
      if (match) return match;
    }
    return undefined;
  }

  it("carries remind mode into the Next button's value", async () => {
    const approvals = await listApprovals({
      organizationId: agency.organization.id,
      statuses: OPEN_LIST_STATUSES,
      limit: LIST_PAGE_SIZE,
    });
    const total = await countApprovals({
      organizationId: agency.organization.id,
      statuses: OPEN_LIST_STATUSES,
    });

    const { blocks } = listBlocks({
      approvals,
      page: 0,
      total,
      timezone: "UTC",
      mode: "remind",
      showAll: false,
    });

    const next = findButton(blocks, "Next →");
    expect(next).toBeDefined();
    expect(decodeListPage(next!.value)).toEqual({ page: 1, mode: "remind", showAll: false });
  });

  it("carries showAll into the Previous button's value", async () => {
    const approvals = await listApprovals({
      organizationId: agency.organization.id,
      statuses: RECENT_LIST_STATUSES,
      limit: LIST_PAGE_SIZE,
      offset: LIST_PAGE_SIZE,
    });
    const total = await countApprovals({
      organizationId: agency.organization.id,
      statuses: RECENT_LIST_STATUSES,
    });

    const { blocks } = listBlocks({
      approvals,
      page: 1,
      total,
      timezone: "UTC",
      mode: "default",
      showAll: true,
    });

    const previous = findButton(blocks, "← Previous");
    expect(previous).toBeDefined();
    expect(decodeListPage(previous!.value)).toEqual({ page: 0, mode: "default", showAll: true });
  });

  it("gives remind mode a one-click button, not an overflow menu, on every page", async () => {
    const approvals = await listApprovals({
      organizationId: agency.organization.id,
      statuses: OPEN_LIST_STATUSES,
      limit: LIST_PAGE_SIZE,
      offset: LIST_PAGE_SIZE,
    });
    const total = await countApprovals({
      organizationId: agency.organization.id,
      statuses: OPEN_LIST_STATUSES,
    });

    const { blocks } = listBlocks({
      approvals,
      page: 1,
      total,
      timezone: "UTC",
      mode: "remind",
      showAll: false,
    });

    const rows = (blocks as { type: string; accessory?: { type: string } }[]).filter(
      (b) => b.type === "section" && b.accessory,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.accessory!.type === "button")).toBe(true);
  });
});
