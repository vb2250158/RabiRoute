function parseArgs(argv) {
  const options = {
    url: "",
    token: "",
    message: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const next = argv[index + 1];
    if (!item.startsWith("--")) {
      continue;
    }
    const key = item.slice(2);
    if (next === undefined || next.startsWith("--")) {
      options[key] = "true";
    } else {
      options[key] = next;
      index += 1;
    }
  }

  return options;
}

function usage() {
  console.log(`Usage:
  node scripts/send-onebot-message.mjs --url <current-OneBot-HTTP-URL> --group 123456 --message "中文测试"
  node scripts/send-onebot-message.mjs --url <current-OneBot-HTTP-URL> --user 123456 --message "中文测试\\n第二行"

Options:
  --url      Required current OneBot HTTP base URL for the intended account
  --token    Optional OneBot access token
  --group    Target group_id for send_group_msg
  --user     Target user_id for send_private_msg
  --message  Message text. Use quoted strings; \\n is converted to real newlines.
`);
}

const options = parseArgs(process.argv.slice(2));

if (!String(options.url).trim() || options.url === "true") {
  console.error("OneBot URL is required: provide --url for the intended account; no message was sent.");
  usage();
  process.exit(1);
}

if (!options.message || (!options.group && !options.user)) {
  usage();
  process.exit(1);
}

const baseUrl = String(options.url).replace(/\/$/, "");
const isGroup = Boolean(options.group);
const action = isGroup ? "send_group_msg" : "send_private_msg";
const endpoint = `${baseUrl}/${action}`;
const message = String(options.message).replace(/\\n/g, "\n");
const body = isGroup
  ? { group_id: String(options.group), message }
  : { user_id: String(options.user), message };

const headers = {
  "Content-Type": "application/json; charset=utf-8"
};

if (options.token) {
  headers.Authorization = `Bearer ${options.token}`;
}

const response = await fetch(endpoint, {
  method: "POST",
  headers,
  body: JSON.stringify(body)
});

const text = await response.text();
console.log(text);

if (!response.ok) {
  process.exitCode = 1;
}
