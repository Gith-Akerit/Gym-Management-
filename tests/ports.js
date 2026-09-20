// Which ports this run of the browser suite owns.
//
// They used to be hardcoded at 4310/4311, and `free-port.js` killed whoever
// held them. On a machine where two agents work at once that is two runs
// killing each other's servers: the symptoms were a server vanishing
// mid-test, an OTP cooldown on a database that had just been created, and a
// spec reading the menu of somebody else's build. Set UI_PORT and
// UI_PILOT_PORT to give a run its own pair (QA, ข้อ 4).
export const UI_PORT = Number(process.env.UI_PORT || 4310);
export const UI_PILOT_PORT = Number(process.env.UI_PILOT_PORT || UI_PORT + 1);

// A third server with the public sign-up form switched on. The gym runs with
// it off, which is what the other two servers are, so the specs that cover
// that journey need somewhere it exists rather than a flag flipped underneath
// the spec that checks the front door has only two buttons on it.
export const UI_OPEN_PORT = Number(process.env.UI_OPEN_PORT || UI_PORT + 2);
