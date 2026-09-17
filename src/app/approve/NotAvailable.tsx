/** What a bad, expired or already-settled link shows. Deliberately vague. */
export function NotAvailable({ reason }: { reason: "expired" | "invalid" }) {
  return (
    <main className="page">
      <div className="card result">
        <div className="result-mark" aria-hidden="true">
          🔗
        </div>
        <h1>
          {reason === "expired"
            ? "This approval link has expired"
            : "This approval link isn't valid"}
        </h1>
        <p className="muted">
          {reason === "expired"
            ? "Links stop working once the request is long past. Ask the agency for a fresh one."
            : "Double-check you copied the whole link from the email, or ask the agency to resend it."}
        </p>
      </div>
    </main>
  );
}
