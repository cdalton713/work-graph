"""Drive the installed command against local repositories and recorded service boundaries."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from services import Handler, fixture_service
from suite import help_flags, run_case


def write(path, data):
    path.write_text(json.dumps(data))


def read(path):
    return json.loads(path.read_bytes())


def page(nodes):
    return {"nodes": list(nodes), "pageInfo": {"hasNextPage": False, "endCursor": None}}


def scenario(binary, root):
    core = root / "core"
    work = root / "work"
    tools = root / "tools"
    for directory in (core, work, tools):
        directory.mkdir()
    def git(*args, cwd=work):
        return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()
    git("init", "-q", "-b", "main")
    git("-c", "user.name=Example", "-c", "user.email=local@example.invalid",
        "commit", "--allow-empty", "-qm", "base")
    base = git("rev-parse", "HEAD")
    git("worktree", "add", "-q", "--detach", str(core), "main")
    git("switch", "-qc", "wg/wf-spike-a")
    git("update-ref", "refs/remotes/origin/main", base)
    unrelated = root / "unrelated"
    git("worktree", "add", "-q", "--detach", str(unrelated), "main")
    trees = root / "trees"
    write(trees, [{"id": k, "repoId": "repo", "path": str(p), "branch": b,
                   "parentWorktreeId": parent, "isMainWorktree": False, "childWorktreeIds": []}
                  for k, p, b, parent in [("core", core, "coordinator", None),
                                         ("child", work, "wg/wf-spike-a", "core"),
                                         ("other", unrelated, "other", None)]])
    events = root / "events"
    events.touch()
    def tool(name, body):
        path = tools / name
        path.write_text(f"#!{sys.executable}\nimport json,os,sys\nfrom pathlib import Path\n"
                        "args=sys.argv[1:]\nroot=Path(os.environ['FIXTURE'])\n"
                        "with (root/'events').open('a') as f: print(json.dumps(args),file=f)\n"+body)
        path.chmod(0o755)
    tool("orca", """trees=root/'trees'
if args[:2]==['worktree','list']: r={'worktrees':json.loads(trees.read_text()),'truncated':False}
elif args[:2]==['worktree','set']: r={}
elif args[:2]==['worktree','rm']:
    id=args[3].removeprefix('id:')
    trees.write_text(json.dumps([t for t in json.loads(trees.read_text()) if t['id']!=id]))
    r={}
elif args[:2]==['orchestration','worker-start']:
    if '--retry-request' not in args:
        print(json.dumps({'ok':False,'error':{'data':{'recovery':{'orchestrationRequestId':'request-id'}}}}))
        sys.exit(1)
    assert args[-1]=='request-id'
    r={'dispatchId':'dispatch-id','taskId':'task-id','runId':'run-id'}
else: raise AssertionError(args)
print(json.dumps({'result':r}))
""")
    tool("gh", """if args[:2]==['pr','view']:
    r={'url':'https://example.invalid/pr/1','commits':[{}],'state':'OPEN','headRefName':'topic',
       'baseRefName':'main','headRefOid':(root/'sha').read_text(),'isDraft':True}
elif args[0]=='api':
    sys.exit(0)
elif args[:2]==['pr','checks']:r=[]
elif args[:2]==['pr','list']:r=[{'number':1}]
else:raise AssertionError(args)
print(json.dumps(r))
""")
    plan = read(HERE / "fixture/plan.json")
    plan["effort"].update(slug="wf",test=["sh","-c","echo fixture"])
    plan["nodes"][0]["kind"] = "spike"
    write(core/"plan.json", plan)
    km = read(HERE / "fixture/keymap.json")
    km["run"] = {"effort":{"wave":"a"},"nodes":{}}
    write(core/"keymap.json", km)
    cfg = root/"config"
    write(cfg, {"worker_settings":{"codex":{"features":{"worker":True}}},"release_branch":"release","workspaces":[{"id":"default","team":"EX",
                                                            "page_url":"https://page.invalid"}]})
    issue = {"id":"issue-a","identifier":"EX-1","url":"https://example.invalid/1",
             "state":{"name":"Ready","type":"unstarted"},"team":{"id":"team"},
             "labels":page([]),"relations":page([])}
    below_issue = dict(issue,id="issue-b",identifier="EX-2",state={"type":"completed","name":"Done"})
    states = page({"id":s,"name":s} for s in ["Ready","In Progress","Done","In Review"])
    comments = []
    errors = []
    actions = []
    label_ops = []
    project_updates = []
    released = []
    reject_receipt = True
    reject_review_move = True
    def post(h):
        nonlocal reject_receipt, reject_review_move
        data = json.loads(h.rfile.read(int(h.headers["Content-Length"])))
        if h.path.endswith("/claims/a"):
            assert h.headers["Authorization"]=="Bearer token" and (data.get("takeover") or data["job"]=="dispatch")
            action=actions.pop(0)
            if action=="unavailable":return h.send_error(503)
            if action=="refused":return h.send_error(409)
            if action=="uncertain":return h.reply({})
            return h.reply({"action":action})
        q=data["query"];v=data["variables"]
        if "issues(first:25" in q:r={"issues":page(i for i in [issue,below_issue] if i["id"] in v["ids"])}
        elif "projectStatuses{" in q:
            status={"id":"planned","type":"planned","createdAt":"group-b"}
            target={"id":"started-b","name":"In Progress","type":"started","createdAt":"group-b"}
            r={"project":{"status":target if project_updates else status},
               "projectStatuses":page([dict(target,id="started-a",createdAt="group-a"),target])}
        elif "projectUpdate(" in q:
            project_updates.append(v["s"])
            r={"projectUpdate":{"success":True}}
        elif "issueLabels(" in q:r={"issueLabels":page([{"id":"new","name":"agent:codex","team":None}])}
        elif "team(id:" in q:r={"team":{"states":states}}
        elif "teams(filter:" in q:r={"teams":page([{"id":"team","states":states}])}
        elif "issueUpdate(" in q:
            inp=v["i"]
            if inp.get("stateId")=="In Review" and reject_review_move:
                reject_review_move=False
                return h.reply({"errors":[{"message":"interrupted status update"}]})
            if "stateId" in inp:issue["state"]={"name":inp["stateId"],"type":"started"}
            if "removedLabelIds" in inp:
                label_ops.append(("remove",inp["removedLabelIds"]))
                issue["labels"]=page(l for l in issue["labels"]["nodes"] if l["id"] not in inp["removedLabelIds"])
            if "addedLabelIds" in inp:
                label_ops.append(("add",inp["addedLabelIds"]))
                issue["labels"]=page([{"id":"new","name":"agent:codex"}])
            r={"issueUpdate":{"success":True}}
        elif "description" in q:r={"issue":{"description":"Research the test case."}}
        elif "commentCreate(" in q:
            if v["i"]["body"].startswith("Claimed:") and reject_receipt:
                reject_receipt=False
                return h.reply({"errors":[{"message":"receipt interrupted"}]})
            comments.append(v["i"]["body"])
            r={"commentCreate":{"success":True,"comment":{"id":"c"}}}
        elif "commentUpdate(" in q:r={"commentUpdate":{"success":True,"comment":{"id":"c"}}}
        elif "organization{" in q:r={"organization":{"subscription":{"type":"paid"}}}
        elif "attachments(" in q:r={"issue":{"attachments":page([{"url":"https://example.invalid/pr/1"}])}}
        else:
            errors.append(q)
            return h.send_error(400)
        h.reply({"data":r})
    def get(h):
        assert h.headers["Authorization"]=="Bearer token"
        if h.path.endswith("/plan"):
            h.send_response(304);h.end_headers()
        elif h.path.endswith("/claims"):
            h.reply({"role":"collaborator","claims":[{"mine":True,"node":"a","job":"review"}]})
        else:h.send_error(404)
    def delete(h):
        assert h.path.endswith("/claims/a") and h.headers["Authorization"]=="Bearer token"
        released.append(h.path)
        h.send_response(204)
        h.end_headers()
    with patch.object(Handler,"do_DELETE",delete,create=True),patch.object(Handler,"do_POST",post),patch.object(Handler,"do_GET",get),fixture_service() as (settings,_):
        env=dict(settings,HOME=str(root),PATH=str(tools)+":"+os.defpath,WG_CONFIG=str(cfg),
                 WG_DEFAULT_LINK_TOKEN="token",WG_LINK="off",ORCA_AGENT_SESSION_ID="fixture",
                 ORCA_CLI_COMMAND=str(tools/"orca"),FIXTURE=str(root))
        def run(verb,*args,code=0):
            r=subprocess.run([binary,verb,str(core),*args],env=env,cwd=work,capture_output=True,text=True,timeout=25)
            assert r.returncode==code,(verb,args,r.returncode,r.stdout,r.stderr,errors)
            return r
        def row():
            return read(core/"keymap.json")["run"]["nodes"]["a"]
        def calls():
            return [json.loads(line) for line in events.read_text().splitlines()]
        settings_file=work/".codex/config.toml"
        settings_file.parent.mkdir()
        excluded=work/git("rev-parse","--git-path","info/exclude")
        with excluded.open("a") as f:f.write("\n/.codex/config.toml\n")
        settings_file.write_text('model = "existing"\n')
        run("dispatch","a","--run",code=1)
        assert 'model = "existing"' in settings_file.read_text()
        assert 'worker = true' in settings_file.read_text()
        assert row()["retry_request"]=="request-id"
        run("dispatch","a","--run",code=1)
        assert row()["step"]=="receipt" and row()["dispatch"]=="dispatch-id"
        run("dispatch","a","--run")
        starts=[a for a in calls() if a[:2]==["orchestration","worker-start"]]
        assert project_updates==["started-b"]
        assert len(starts)==2 and "--retry-request" in starts[1]
        assert "Research the test case." in (core/"specs/a.md").read_text()
        assert len([c for c in comments if c.startswith("Claimed:")])==1
        run("done","a","--dispatch","stale",code=1)
        assert row()["state"]=="running" and issue["labels"]["nodes"]
        (work/"pending").write_text("preserve")
        run("done","a","--dispatch","dispatch-id")
        assert issue["state"]["name"]=="Done" and [t["id"] for t in read(trees)]==["core","child","other"]
        run("cleanup","--dry-run",code=1)
        assert (work/"pending").read_text()=="preserve"
        (work/"pending").unlink()
        run("done","a","--dispatch","dispatch-id")
        assert [t["id"] for t in read(trees)]==["core","other"]
        plan["nodes"][0]["kind"]="task"
        write(core/"plan.json",plan)
        git("switch","-qc","topic")
        (work/"src").mkdir()
        (work/"src/change").write_text("example")
        git("add","src/change")
        git("-c","user.name=Example","-c","user.email=local@example.invalid","commit","-qm","change")
        (root/"sha").write_text(git("rev-parse","HEAD"))
        km=read(core/"keymap.json")
        km["run"]["nodes"]["a"]={"branch":"topic","parent":"main","lower":"main",
                                 "dispatch":"dispatch-id","pr":"1","agent":"codex"}
        write(core/"keymap.json",km)
        issue["state"]["name"]="In Progress"
        run("verify","a",code=1)
        run("evidence","a")
        evidence_file=core/"evidence/a.json"
        evidence=read(evidence_file)
        assert evidence["sha"]==(root/"sha").read_text()
        run_state=read(core/"keymap.json")
        for reason,exit_code,expected in [("known failure",None,"command exit: None"),
                                          ("  ",1,"acceptance needs a reason"),
                                          ("known failure",1,"accepted: known failure")]:
            run_state["run"]["nodes"]["a"]["tests_accepted"]=evidence["sha"]+":"+reason
            write(core/"keymap.json",run_state)
            record=dict(evidence,exit=exit_code)
            if exit_code is None: del record["exit"]
            write(evidence_file,record)
            assert expected in run("verify","a",code=int(expected!="accepted: known failure")).stdout
        write(evidence_file,evidence)
        owns=plan["nodes"][0]["owns"]
        for pattern,shared,expected in [("s***ge",[],None),("outside",["src/**"],"SHARED src/change"),
                                        ("outside",[],"OUT src/change")]:
            plan["nodes"][0].update(owns=[pattern],shares=shared)
            write(core/"plan.json",plan)
            result=run("verify","a",code=int(expected=="OUT src/change"))
            if expected:assert expected in result.stdout
        plan["nodes"][0].update(owns=owns,shares=[])
        write(core/"plan.json",plan)
        assert "interrupted status update" in run("done","a","--dispatch","dispatch-id",code=2).stderr
        assert issue["state"]["name"]=="In Progress"
        run("done","a","--dispatch","dispatch-id")
        assert row()["code_done_head"]==(root/"sha").read_text() and issue["state"]["name"]=="In Review"
        run("verify","a")
        blob=subprocess.check_output(["git","hash-object","-w","--stdin"],input=b"main",cwd=work).decode().strip()
        git("update-ref","refs/stax/trunk",blob)
        assert "stax trunk" in run("base").stdout
        km=read(core/"keymap.json")
        km["run"]["nodes"]["a"]["path"]=str(work)
        km["collab"]={"project":"p","page":"https://page.invalid","workspace":"shared:test","name":"Example",
                      "version":1,"settings":{"workspace":"default","team":"EX","slug":"wf"},
                      "plan_sha":hashlib.sha256((core/"plan.json").read_bytes()).hexdigest()}
        write(core/"keymap.json",km)
        issue["labels"]=page([{"id":"old","name":"agent:claude"}])
        before=list(label_ops)
        actions.extend(["refused","uncertain","renewed","taken_over"])
        for _ in range(2):
            run("claim","a","review","--takeover",code=2)
            assert label_ops==before and issue["labels"]["nodes"][0]["id"]=="old"
        # The first reply may have been lost after a successful transfer. Renewal
        # alone cannot authorize deletion of a pre-existing Linear label.
        run("claim","a","review","--takeover",code=1)
        assert label_ops==before and issue["labels"]["nodes"][0]["id"]=="old"
        run("claim","a","review","--takeover")
        assert label_ops[len(before):]==[("remove",["old"]),("add",["new"])]
        km=read(core/"keymap.json");del km["collab"];write(core/"keymap.json",km)
        run("started","a","dispatch=next","task=t")
        assert row()["dispatch"]=="next" and row()["state"]=="running"
        run("done","a","--dispatch","next","--failed","fixture failure")
        assert row()["state"]=="failed" and comments[-1].endswith("fixture failure")
        for mode in ["tracked","symlink"]:
            original='model = "protected"\n'
            settings_file.write_text(original)
            if mode=="tracked":
                git("add","-f",".codex/config.toml")
            else:
                external=root/"external"
                external.write_text(original)
                settings_file.unlink()
                settings_file.symlink_to(external)
            response=run("claim","a","review","--model",mode)
            assert mode in response.stderr and settings_file.read_text()==original
            run("started","a","dispatch="+mode)
            run("done","a","--dispatch",mode,"--failed","guard tested")
            if mode=="tracked":git("rm","--cached","-q",".codex/config.toml")
        # Resume a collaborative job whose lower branch exists only on origin.
        lower="shared/parent"
        git("init","--bare","-q",str(root/"remote"))
        git("remote","add","origin",str(root/"remote"))
        git("push","-q","origin","main:refs/heads/"+lower)
        git("update-ref","-d","refs/remotes/origin/"+lower)
        km=read(core/"keymap.json")
        plan["nodes"].append(dict(plan["nodes"][0],key="below"))
        plan["edges"].append({"from":"a","to":"below"})
        write(core/"plan.json",plan)
        km["collab"]={"project":"p","page":"https://page.invalid","workspace":"shared:test","name":"Example",
                      "version":1,"settings":{"workspace":"default","team":"EX","slug":"wf"},
                      "plan_sha":hashlib.sha256((core/"plan.json").read_bytes()).hexdigest()}
        km["nodes"]["below"]={"id":"issue-b","identifier":"EX-2","branch":lower,"pr":"2"}
        km["run"]["nodes"]["a"]={"agent":"codex","branch":"topic","parent":lower,"lower":lower,
                                 "state":"creating","job":"dispatch","step":"parent"}
        write(core/"keymap.json",km)
        issue.update(state={"type":"started","name":"In Progress"},labels=page([{"id":"new","name":"agent:codex"}]))
        metadata=subprocess.check_output(["git","hash-object","-w","--stdin"],cwd=work,
                                         input=json.dumps({"parentBranchName":lower}).encode()).decode().strip()
        git("update-ref","refs/branch-metadata/topic",metadata)
        inventory=read(trees)
        inventory.extend([dict(inventory[0],id="lane",branch="wg/wf-local",parentWorktreeId="core",path=str(unrelated)),
                          dict(inventory[0],id="child",branch="topic",parentWorktreeId="lane",path=str(work))])
        write(trees,inventory)
        actions.extend(["unavailable","refused","claimed","claimed"])
        run("dispatch","a","--run",code=2)
        assert len(released)==1
        run("dispatch","a","--run",code=2)
        assert len(released)==1
        run("dispatch","a","--run",code=1)
        assert git("rev-parse",lower)==base
        assert git("rev-parse",lower+"@{upstream}") == base
        assert len(released)==2 and row()["retry_request"]=="request-id"
        run("dispatch","a","--run")
        assert len(released)==2 and row()["state"]=="running"
        starts=[a for a in calls() if a[:2]==["orchestration","worker-start"]]
        assert len(starts)==4 and "--retry-request" in starts[-1]
        # The parent was rewritten and squash-merged after the child forked.
        fork=git("rev-parse","topic")
        git("config","user.name","Example")
        git("config","user.email","local@example.invalid")
        rewritten=git("commit-tree",git("rev-parse","topic^{tree}"),"-p",base,"-m","rewritten parent")
        git("update-ref","refs/heads/"+lower,rewritten)
        squash=git("commit-tree",git("rev-parse","topic^{tree}"),"-p",base,"-m","squash parent")
        git("push","-q","origin",squash+":refs/heads/main")
        for name in ["one","two"]:
            (work/name).write_text(name)
            git("add",name)
            git("commit","-qm","child "+name)
        assert git("merge-base","topic",lower)==base
        km=read(core/"keymap.json")
        del km["collab"]
        km["run"]["nodes"]["below"]={"code_done_head":fork}
        def instruction(revision):
            meta={"parentBranchName":lower,"parentBranchRevision":revision}
            blob=subprocess.check_output(["git","hash-object","-w","--stdin"],cwd=work,
                                         input=json.dumps(meta).encode()).decode().strip()
            git("update-ref","refs/branch-metadata/topic",blob)
            km["run"]["nodes"]["a"]={"branch":"topic","parent":lower,"lower":lower,"pr":"1",
                                     "agent":"codex","dispatch":"old","path":str(work)}
            write(core/"keymap.json",km)
            issue["labels"]=page([])
            run("claim","a","restack")
            spec=(core/"specs/a-restack.md").read_text()
            return spec.split("; refresh: ",1)[1].split(", then st branch reparent",1)[0].split()
        correct=["git","rebase","--onto","origin/main",fork]
        emitted=instruction(fork)
        assert emitted==correct
        # Without usable stax metadata the reference uses the local merge base,
        # which can precede the old fork when the parent was rewritten.
        for revision in [rewritten,base,"unavailable"]:
            assert instruction(revision)==correct[:-1]+[base]
        git("update-ref","-d","refs/heads/"+lower)
        assert instruction("unavailable")==correct
        git("branch","release",rewritten)
        git("push","-q","origin","main:refs/heads/release")
        for role in ["sync","hotfix"]:
            plan["nodes"][0]["role"]=role
            write(core/"plan.json",plan)
            assert instruction(fork)==["git","rebase","--onto","origin/release",fork]
            text=(core/"specs/a-restack.md").read_text()
            assert f"target release at {base}; base: {role}; parent merged: yes" in text
            assert row()["lower"]=="origin/main"
            # If the recorded parent is already the bottom, the merged node below
            # must not trigger a second reparent to the release pin.
            km["run"]["nodes"]["a"].update(parent="main",lower="main")
            issue["labels"]=page([])
            write(core/"keymap.json",km)
            run("claim","a","restack")
            assert f"target release at {base}; base: {role}; parent merged: no" in (core/"specs/a-restack.md").read_text()
            assert row()["lower"]=="main"
        del plan["nodes"][0]["role"]
        plan["phases"][0]["target"]="frozen"
        write(core/"plan.json",plan)
        metadata=subprocess.check_output(["git","hash-object","-w","--stdin"],cwd=work,
                                         input=b'{"sourceRemote":"origin","frozen":true}').decode().strip()
        git("update-ref","refs/branch-metadata/frozen",metadata)
        git("branch","frozen",base)
        git("push","-q","origin",squash+":refs/heads/frozen")
        assert instruction(fork)==["git","rebase","--onto","origin/frozen",fork]
        assert git("rev-parse","frozen")==squash
        assert f"target frozen at {squash}; base: frozen;" in (core/"specs/a-restack.md").read_text()
        # With a narrow fetch refspec, a local fast-forward can leave a stale remote ref.
        git("config","remote.origin.fetch","+refs/heads/main:refs/remotes/origin/main")
        git("update-ref","refs/remotes/origin/frozen",base)
        issue["labels"]=page([])
        write(core/"keymap.json",km)
        assert "differ after the base refresh" in run("claim","a","restack",code=2).stderr
        assert row()["lower"]==lower
        git(*emitted[1:])
        assert git("log","--reverse","--format=%s","origin/main..HEAD").splitlines()==["child one","child two"]
        assert not errors,errors


candidate=str(Path(sys.argv[1]).resolve())
cases=read(HERE/"expected.json")
verbs={"dispatch","claim","started","done","base","cleanup","evidence","verify"}
for case,expected in cases.items():
    if case.split()[0] in verbs and "--help" in case:
        result=run_case([candidate],case.split(),False)
        assert result["exit"]==0 and help_flags(result["stdout"])==expected,(case,result,expected)
    elif case.split()[0] in verbs:
        actual=run_case([candidate],case.split(),False)
        assert actual==expected,(case,actual,expected)
with tempfile.TemporaryDirectory() as temp:
    scenario(candidate,Path(temp))
