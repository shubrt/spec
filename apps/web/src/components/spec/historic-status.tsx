import { asEntityStatus } from "~/lib/vocabulary";
import { Box, StatusCell } from "./box";

/**
 * A status read out of a revision snapshot.
 *
 * Every other status on this surface comes from a live row and is one of the five
 * vocabularies. This one comes from a document that may predate a schema change, so
 * the value can be one this app has never heard of — which is a historical fact, not
 * a fault. It renders as itself in that case rather than being coerced into a
 * vocabulary it does not belong to.
 */
export function HistoricStatus({
  status,
  muted,
}: {
  readonly status: string;
  readonly muted?: boolean;
}) {
  const known = asEntityStatus(status);
  if (known) return <StatusCell status={known} muted={muted} />;
  return (
    <Box
      tone="quiet"
      title="A status this version of the app does not know — read from an older revision"
    >
      {status}
    </Box>
  );
}
