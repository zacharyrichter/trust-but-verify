// Komodo Action: "Renovate Git Commit" (rename to whatever fits your setup)
//
// Purpose: this is the Action your Git server's webhook should point at
// directly. It receives the raw push-event payload, checks whether any
// commit in the push was authored by your update bot's account, and only
// if so, triggers the deploy Procedure via Komodo's own API.
//
// Forgejo/Gitea (and GitHub) cannot filter webhook deliveries by commit
// author from the UI — that check has to happen in code, on the receiving
// end. This script is that check.
//
// ARGS (set these as this Action's Default Arguments in the Komodo UI,
// using the JSON format selector, not Key-Value -- see the writeup for why
// that distinction matters):
//
//   BOT_USERNAME  => exact username of your update bot's account
//   BASE_BRANCH   => (optional) restrict to one branch, e.g. "main"
//   PROCEDURE_ID  => id of the Procedure to trigger on a match
//   COMMIT        => bool. false/omitted = dry run (logs only, no deploy)
//
// How the payload arrives: when this Action is invoked by a webhook,
// Komodo merges the raw request body into ARGS as ARGS.WEBHOOK_BODY. This
// is not obvious from Komodo's docs and is worth confirming yourself
// against a real webhook delivery (Recent Deliveries on the Git server's
// webhook settings page) before trusting this in production -- payload
// shapes can change between Komodo versions.

const body = ARGS.WEBHOOK_BODY;
const commit = ARGS.COMMIT === 'true' || ARGS.COMMIT === true;

const {
  commits = []
} = body;

if (commits.length > 0) {
  const {
    ref,
  } = body;

  if (ARGS.BOT_USERNAME === undefined) {
    throw new Error('BOT_USERNAME arg must be defined!');
  }

  if (ARGS.BASE_BRANCH !== undefined) {
    if (!ref.includes(ARGS.BASE_BRANCH)) {
      console.log(`Base branch wanted '${ARGS.BASE_BRANCH}' but found '${ref}', ignoring this webhook event.`);
      return;
    }
  } else {
    console.log('No base branch check required.');
  }

  // Match on username, not email. Some Git servers only populate a
  // commit's `username` field in webhook payloads if the commit's
  // git-config email exactly matches a VERIFIED email on an existing
  // account -- a typo in that stored email means every commit from the
  // right account shows up here with an empty username, indistinguishable
  // from "wrong author" unless you inspect the raw payload directly.
  const botCommits = commits.filter(x => {
    const {
      author: {
        username: authorUser
      } = {},
      committer: {
        username: commitUser
      } = {}
    } = x;
    return authorUser === ARGS.BOT_USERNAME || commitUser === ARGS.BOT_USERNAME;
  });

  if (botCommits.length === 0) {
    console.log(`No commits by username ${ARGS.BOT_USERNAME}`);
    return;
  }

  console.log(`Found ${botCommits.length} by username ${ARGS.BOT_USERNAME}:\n${botCommits.map(x => x.message).join('\n')}`);

  const pid = ARGS.PROCEDURE_ID;
  console.log(`${commit === false ? '[DRY RUN] ' : ''}Triggering procedure ${pid}`);
  if (undefined === pid) {
    throw new Error('Cannot trigger procedure because no ID was provided as arg PROCEDURE_ID');
  }
  if (commit) {
    await komodo.execute('RunProcedure', { procedure: pid });
  }
}
