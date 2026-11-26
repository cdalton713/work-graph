Run `sh tests/cli-parity/run.sh` to test the Python reference. To compare another executable against the same records, pass its path as the only argument. CI runs both forms with Python 3.11 through 3.14. The candidate smoke test invokes the reference under the name `wg`. The migration phase evidence command runs the reference suite.

Each line of `cases.txt` runs in a fresh directory with a synthetic home, plan, keymap and journal. The legacy keymap has no `run` section. The write cases check the new section, the journal entries, and the fields carried over from the old keymap.

The suite records short and long flags, exit status, both output streams, file contents and permissions, and external tool calls. It compares the contract output to the page contract, including its node card examples. For parser errors it normalizes the program name and synopsis line wrapping. For `doctor effort` it compares the plan, keymap and worktree diagnostics. The other diagnostics depend on the OS and installed tools.

Cases marked `service |` use an HTTPS fixture on loopback. It accepts the test credentials and answers the recorded Linear and page operations locally. OpenSSL generates a temporary certificate for each case. A candidate must honor `https_proxy` and trust the fixture certificate in `SSL_CERT_FILE`. The suite checks the comment body written for the fixture node, the project label read, the token check requests, and the resulting local state.

After a deliberate contract change, run `sh tests/cli-parity/run.sh --record` and review the diff in `expected.json`. Add new command cases to `cases.txt`.
