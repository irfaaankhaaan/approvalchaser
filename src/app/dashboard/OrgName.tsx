"use client";

import { useActionState, useState } from "react";
import { renameOrganizationAction, type FormState } from "@/app/dashboard/actions";

const IDLE: FormState = { ok: false };

/** Click the agency name to rename it — no settings page needed for one field. */
export function OrgName({ name }: { name: string }) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState(renameOrganizationAction, IDLE);

  if (!editing) {
    return (
      <button
        type="button"
        className="org-name"
        onClick={() => setEditing(true)}
        title="Click to rename"
      >
        {name} ✎
      </button>
    );
  }

  return (
    <form
      action={(formData) => {
        formAction(formData);
        setEditing(false);
      }}
      style={{ display: "flex", gap: 6, alignItems: "center" }}
    >
      <input
        type="text"
        name="name"
        defaultValue={name}
        maxLength={120}
        autoFocus
        style={{ width: 220, padding: "4px 8px", fontSize: 14 }}
      />
      <button type="submit" disabled={pending} style={{ padding: "4px 10px", fontSize: 13 }}>
        Save
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        style={{ padding: "4px 10px", fontSize: 13 }}
      >
        Cancel
      </button>
      {state.error ? <span className="error">{state.error}</span> : null}
    </form>
  );
}
