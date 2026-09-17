import { describe, expect, it } from "vitest";
import {
  ALLOWED_TRANSITIONS,
  InvalidTransitionError,
  assertTransition,
  canTransition,
  isChaseable,
  isOpen,
  isTerminal,
  statusLabel,
} from "@/lib/approvals/state";
import type { ApprovalStatus } from "@/lib/db/types";

describe("approval state machine", () => {
  it("allows the happy path: draft -> waiting -> viewed -> approved", () => {
    expect(canTransition("draft", "waiting")).toBe(true);
    expect(canTransition("waiting", "viewed")).toBe(true);
    expect(canTransition("viewed", "approved")).toBe(true);
  });

  it("allows a client to ask for changes once they have looked", () => {
    expect(canTransition("viewed", "changes_requested")).toBe(true);
  });

  it("allows an open approval to go overdue", () => {
    expect(canTransition("waiting", "overdue")).toBe(true);
    expect(canTransition("viewed", "overdue")).toBe(true);
  });

  it("lets a late client still approve, because a late yes is still a yes", () => {
    expect(canTransition("overdue", "approved")).toBe(true);
    expect(canTransition("overdue", "changes_requested")).toBe(true);
  });

  it("reopens a changes_requested approval into a new waiting round", () => {
    expect(canTransition("changes_requested", "waiting")).toBe(true);
  });

  it("treats approved and cancelled as terminal", () => {
    expect(ALLOWED_TRANSITIONS.approved).toHaveLength(0);
    expect(ALLOWED_TRANSITIONS.cancelled).toHaveLength(0);
    expect(isTerminal("approved")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
  });

  it("refuses to un-approve or un-cancel", () => {
    expect(canTransition("approved", "waiting")).toBe(false);
    expect(canTransition("approved", "changes_requested")).toBe(false);
    expect(canTransition("cancelled", "waiting")).toBe(false);
    expect(canTransition("cancelled", "approved")).toBe(false);
  });

  it("refuses to skip straight from draft to approved", () => {
    expect(canTransition("draft", "approved")).toBe(false);
  });

  it("throws a typed error that names both ends of the illegal move", () => {
    try {
      assertTransition("approved", "waiting");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      expect((error as InvalidTransitionError).from).toBe("approved");
      expect((error as InvalidTransitionError).to).toBe("waiting");
    }
  });

  it("never lets a status transition to itself", () => {
    for (const status of Object.keys(ALLOWED_TRANSITIONS) as ApprovalStatus[]) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it("only chases approvals nobody has answered yet", () => {
    expect(isChaseable("waiting")).toBe(true);
    expect(isChaseable("viewed")).toBe(true);
    // Past the deadline the pre-deadline sequence is meaningless.
    expect(isChaseable("overdue")).toBe(false);
    expect(isChaseable("approved")).toBe(false);
    expect(isChaseable("changes_requested")).toBe(false);
    expect(isChaseable("cancelled")).toBe(false);
  });

  it("counts overdue as open even though it is no longer chaseable", () => {
    expect(isOpen("overdue")).toBe(true);
    expect(isOpen("approved")).toBe(false);
  });

  it("has a label for every status", () => {
    for (const status of Object.keys(ALLOWED_TRANSITIONS) as ApprovalStatus[]) {
      expect(statusLabel(status)).toBeTruthy();
    }
  });
});
