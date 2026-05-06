// In-memory state shared between the socket engine and the
// HTTP event-status flip handler. Required by routes/socket.js
// for the live read/write paths and by server.js's PUT
// /api/events/:id/status which clears both maps when an event
// flips to Completed.
//
// Keep the surface tiny — these are intentionally just maps; any
// "is held?" / "who's diving?" predicates live in the consumer.
//
// IMPORTANT: this is a single-instance design. Clustering would
// split-brain these maps across workers (half the judges seeing
// one active diver, the other half seeing the previous one).
// Either move both to Redis or stay single-instance — see
// ecosystem.config.js for the matching invariant.

// event_id → state-update payload (the latest set_active_diver).
// Read on socket connect to bring late-arriving judges/spectators
// up to speed; cleared on event status → Completed.
const activeDivers = {};

// event_id → { reason, since }. Toggled by Control Room socket
// events; the Scoreboard + Judge views render a banner while held.
// Cleared on 'meet_resume' or when the event finalises.
const meetHolds = {};

module.exports = { activeDivers, meetHolds };
