use super::{Client, Timing, command::Options};
use crate::HttpTransport;
use serde_json::{Value, json};
use std::{fmt::Display, time::Duration};

type Result<T> = std::result::Result<T, String>;

fn field<'a>(obj: &'a Value, key: &str) -> Result<&'a str> {
    obj[key]
        .as_str()
        .ok_or_else(|| format!("Linear did not return {key}"))
}
fn rows(obj: &Value) -> Result<&Vec<Value>> {
    obj.as_array()
        .ok_or_else(|| "Linear did not return nodes".into())
}

pub(super) fn install<S, H: HttpTransport, T: Timing>(
    client: &mut Client<S, H, T>,
    options: &Options,
    human: &str,
    scoped: bool,
) -> Result<()>
where
    H::Error: Display,
{
    let contract: Value =
        serde_json::from_str(include_str!("../../../skills/work-graph/contract.json"))
            .expect("embedded contract");
    let contract = &contract["setup"];
    let mut setup = Setup {
        client,
        apply: options.apply,
        missing: false,
    };
    let team = setup.ensure_team(options)?;
    setup.workflow(&team, human, &contract["statuses"])?;
    let id = team["id"].as_str();
    setup.label_scope(
        "issueLabel",
        id,
        true,
        &contract["team_issue_labels"],
        &Value::Null,
    )?;
    setup.label_scope(
        "issueLabel",
        id,
        false,
        &Value::Null,
        &contract["workspace_label_groups"],
    )?;
    setup.label_scope(
        "projectLabel",
        id,
        scoped,
        &contract["project_labels"],
        &contract["project_label_groups"],
    )?;
    if !setup.missing {
        println!("nothing is missing");
    } else if !options.apply {
        println!("Run again with --apply to make missing items.");
    }
    Ok(())
}

struct Setup<'a, 'b, S, H, T> {
    client: &'a mut Client<'b, S, H, T>,
    apply: bool,
    missing: bool,
}
impl<S, H: HttpTransport, T: Timing> Setup<'_, '_, S, H, T>
where
    H::Error: Display,
{
    fn missing(&mut self, item: &str) {
        self.missing = true;
        println!("missing {item}");
    }
    fn team(&mut self, key: &str) -> Result<Value> {
        let data=self.client.request("query($k:String!){teams(filter:{key:{eq:$k}}){nodes{id visibility triageEnabled parent{key}}}}",json!({"k":key}))?;
        Ok(rows(&data["teams"]["nodes"])?
            .first()
            .cloned()
            .unwrap_or_default())
    }
    fn mutate(&mut self, name: &str, query: &str, vars: Value) -> Result<Value> {
        let mut data = self.client.request(query, vars)?;
        if data[name]["success"] != true {
            return Err(format!("Linear did not confirm {name}"));
        }
        Ok(data[name].take())
    }
    fn update_team(&mut self, id: &str, input: Value) -> Result<()> {
        self.mutate(
            "teamUpdate",
            "mutation($id:String!,$i:TeamUpdateInput!){teamUpdate(id:$id,input:$i){success}}",
            json!({"id":id,"i":input}),
        )?;
        Ok(())
    }
    fn ensure_team(&mut self, options: &Options) -> Result<Value> {
        let key = &options.team;
        let mut team = self.team(key)?;
        let new_team = team.is_null();
        if new_team {
            self.missing(&format!("team {key}"));
        } else {
            println!("exists team {key}");
        }
        let mut item = json!({"key":key,"name":options.name});
        let parent = &options.parent;
        if !parent.is_empty() {
            if new_team {
                let row = self.team(parent)?;
                if row.is_null() {
                    return Err(format!("parent {parent} does not exist or is not visible."));
                }
                item["parentId"] = json!(field(&row, "id")?);
                println!("exists parent {parent}");
            } else {
                let current = team["parent"]["key"].as_str().unwrap_or("none");
                if current == parent {
                    println!("exists parent {parent}");
                } else {
                    println!("warn parent {parent} (current parent: {current})");
                }
            }
        }
        if new_team && self.apply {
            if options.name.is_empty() {
                return Err(format!(
                    "team {key} needs a name. Supply --name <team name>."
                ));
            }
            team=self.mutate("teamCreate","mutation($i:TeamCreateInput!){teamCreate(input:$i){success team{id visibility triageEnabled parent{key}}}}",json!({"i":item}))?["team"].take();
            field(&team, "id")?;
            let actual = team["parent"]["key"].as_str().unwrap_or("none");
            if !parent.is_empty() && actual != parent {
                return Err(format!(
                    "Linear created team {key} with parent {actual}; expected parent {parent}. Check the team in Linear."
                ));
            }
        }
        if options.private && team["visibility"] != "private" {
            self.missing(&format!("private visibility for team {key}"));
            if self.apply {
                team = self.make_private(key, field(&team, "id")?, new_team)?;
            }
        }
        if !options.private || team["visibility"] == "private" {
            println!(
                "Team {key} visibility: {}.",
                team["visibility"].as_str().unwrap_or("public")
            );
        }
        Ok(team)
    }
    fn make_private(&mut self, key: &str, id: &str, new_team: bool) -> Result<Value> {
        if !new_team {
            let data=self.client.request("query($id:String!){team(id:$id){issues(first:1,includeArchived:true){nodes{id}} projects(first:1,includeArchived:true){nodes{id}}}}",json!({"id":id}))?;
            for (name, reason) in [("issues", "an issue"), ("projects", "a project")] {
                if !rows(&data["team"][name]["nodes"])?.is_empty() {
                    return Err(format!(
                        "team {key} has {reason}. Make it private in Linear or rerun with --no-private."
                    ));
                }
            }
        }
        let hint = "Make it private in Linear and run again, or run again with --no-private.";
        let result = self.update_team(id, json!({"private":true}));
        let verified = self.team(key);
        let current = verified.as_ref().ok().filter(|row| row["id"] == id);
        if let Err(e) = result {
            let message = match current {
                Some(row) if row["visibility"] == "private" => {
                    format!("The team {key} is now private. Run setup again to continue.")
                }
                Some(_) => format!("The team {key} exists and is not private. {hint}"),
                None => format!("The team {key} exists. Its privacy could not be verified. {hint}"),
            };
            return Err(format!("{e}\n{message}"));
        }
        let row = verified.map_err(|e| {
            format!("{e}\nThe team {key} exists. Its privacy could not be verified. {hint}")
        })?;
        if row["id"] != id {
            return Err(format!(
                "Linear did not return the team {key} after the update. {hint}"
            ));
        }
        if row["visibility"] != "private" {
            return Err(format!(
                "Linear did not confirm private visibility. The team {key} exists and is not private. {hint}"
            ));
        }
        Ok(row)
    }
    fn states(&mut self, id: &str) -> Result<Vec<Value>> {
        self.client.pages("query($id:String!,$after:String){team(id:$id){states(first:100,after:$after){nodes{id name type} pageInfo{hasNextPage endCursor}}}}",json!({"id":id}),"/team/states")
    }
    fn create(
        &mut self,
        kind: &str,
        input: Value,
        mut reread: impl FnMut(&mut Self) -> Result<Option<Value>>,
    ) -> Result<Value> {
        let verb = format!("{kind}Create");
        let ty = format!("{}{}CreateInput", kind[..1].to_uppercase(), &kind[1..]);
        let query = format!("mutation($i:{ty}!){{{verb}(input:$i){{success {kind}{{id}}}}}}");
        match self.mutate(&verb, &query, json!({"i":input})) {
            Ok(mut result) => {
                field(&result[kind], "id")?;
                Ok(result[kind].take())
            }
            Err(e) => {
                let message = e.to_lowercase();
                if ![
                    "duplicate",
                    "already exists",
                    "already taken",
                    "already been taken",
                ]
                .iter()
                .any(|s| message.contains(s))
                {
                    return Err(e);
                }
                for attempt in 0..10 {
                    if attempt > 0 {
                        self.client.timing.sleep(Duration::from_secs(1));
                    }
                    if let Some(row) = reread(self)? {
                        return Ok(row);
                    }
                }
                Err(e)
            }
        }
    }
    fn workflow(&mut self, team: &Value, human: &str, statuses: &Value) -> Result<()> {
        let id = team["id"].as_str();
        let mut states = match id {
            Some(id) => self.states(id)?,
            None => vec![],
        };
        for status in rows(statuses)? {
            let name = field(status, "name")?.replace("{name}", human);
            let expected = field(status, "type")?;
            let find = |states: &[Value]| {
                states
                    .iter()
                    .find(|s| s["name"] == name)
                    .or_else(|| {
                        states.iter().find(|s| {
                            s["name"]
                                .as_str()
                                .is_some_and(|n| n.eq_ignore_ascii_case(&name))
                        })
                    })
                    .cloned()
            };
            let report = |row: &Value| {
                let actual = row["type"].as_str().unwrap_or(expected);
                if let Some(other) = row["name"].as_str().filter(|n| *n != name) {
                    println!("warn status {name} (exists as '{other}'. Rename it in Linear.)");
                } else if actual != expected {
                    println!("warn status {name} ({actual}, expected {expected})");
                } else {
                    println!("exists status {name} ({actual})");
                }
            };
            if let Some(row) = find(&states) {
                report(&row);
                continue;
            }
            self.missing(&format!("status {name} ({expected})"));
            if !self.apply {
                continue;
            }
            let id = id.ok_or("missing team id")?;
            if expected == "triage"
                && team["triageEnabled"] == false
                && !states.iter().any(|s| s["type"] == "triage")
            {
                self.update_team(id, json!({"triageEnabled":true}))?;
                states = self.states(id)?;
                if let Some(row) = find(&states) {
                    if row["name"] == name && row["type"] == expected {
                        println!("created status {name}");
                    } else {
                        report(&row);
                    }
                    continue;
                }
            }
            if matches!(expected, "triage" | "duplicate") {
                println!(
                    "warn status {name}: Linear manages this status. Check the team's workflow in Linear."
                );
                continue;
            }
            let row = self.create(
                "workflowState",
                json!({"name":name,"type":expected,"teamId":id,"color":"#5E6AD2"}),
                |s| Ok(find(&s.states(id)?)),
            )?;
            if row.get("name").is_some() {
                report(&row);
            }
        }
        Ok(())
    }
    fn labels(&mut self, kind: &str, id: Option<&str>) -> Result<Vec<Value>> {
        let ty = format!("{}{}Filter", kind[..1].to_uppercase(), &kind[1..]);
        let query = format!(
            "query($f:{ty}!,$after:String){{{kind}s(first:100,after:$after,filter:$f){{nodes{{id name isGroup groupType parent{{id name}} retiredAt}} pageInfo{{hasNextPage endCursor}}}}}}"
        );
        let mut labels = vec![];
        for team in std::iter::once(None).chain(id.map(Some)) {
            let filter = team.map_or(json!({"null":true}), |id| json!({"id":{"eq":id}}));
            for mut row in
                self.client
                    .pages(&query, json!({"f":{"team":filter}}), &format!("/{kind}s"))?
            {
                row["team_scoped"] = json!(team.is_some());
                labels.push(row);
            }
        }
        Ok(labels)
    }
    fn label_scope(
        &mut self,
        kind: &str,
        id: Option<&str>,
        scoped: bool,
        plain: &Value,
        groups: &Value,
    ) -> Result<()> {
        let labels = self.labels(kind, id)?;
        let noun = if kind == "issueLabel" {
            "issue label"
        } else {
            "project label"
        };
        let apply = self.apply;
        let mut ensure =
            |name: &str, parent: Option<&str>, group: bool| -> Result<(Option<String>, bool)> {
                let description = format!("{noun}{} {name}", if group { " group" } else { "" });
                let matches =
                    |r: &Value| r["team_scoped"] == scoped && r["parent"]["id"].as_str() == parent;
                let find = |rows: &[Value]| {
                    let mut named = rows.iter().filter(|r| {
                        r["name"]
                            .as_str()
                            .is_some_and(|n| n.eq_ignore_ascii_case(name))
                    });
                    named
                        .clone()
                        .find(|r| matches(r))
                        .or_else(|| named.next())
                        .cloned()
                };
                let (row, created) = if let Some(row) = find(&labels) {
                    (row, false)
                } else {
                    self.missing(&description);
                    if !self.apply {
                        return Ok((None, true));
                    }
                    let mut input = json!({"name":name});
                    if scoped {
                        input["teamId"] = json!(id.ok_or("missing team id")?);
                    }
                    if group {
                        input["isGroup"] = json!(true);
                        input["groupType"] = json!("singleSelect");
                    }
                    if let Some(parent) = parent {
                        input["parentId"] = json!(parent);
                    }
                    (
                        self.create(kind, input, |s| Ok(find(&s.labels(kind, id)?)))?,
                        true,
                    )
                };
                if row.get("team_scoped").is_none() {
                    return Ok((Some(field(&row, "id")?.into()), created));
                }
                if !matches(&row) {
                    let scope = if row["team_scoped"] == true {
                        "team"
                    } else {
                        "workspace"
                    };
                    let location = row["parent"]["name"]
                        .as_str()
                        .or(row["parent"]["id"].as_str())
                        .map_or(" at the top level".into(), |p| format!(" under '{p}'"));
                    println!("warn {description} (exists in {scope} scope{location})");
                } else if row["isGroup"].as_bool().unwrap_or(false) != group
                    || !row["retiredAt"].is_null()
                    || (!group && row["name"] != name)
                    || (group && row["groupType"] != "singleSelect")
                {
                    println!("warn {description} (check its type and availability in Linear)");
                } else {
                    println!("exists {description}");
                    return Ok((Some(field(&row, "id")?.into()), created));
                }
                Ok((None, created))
            };
        for name in plain.as_array().into_iter().flatten() {
            ensure(name.as_str().unwrap(), None, false)?;
        }
        for (name, children) in groups.as_object().into_iter().flatten() {
            let (parent, missing) = ensure(name, None, true)?;
            for child in rows(children)? {
                let child = child.as_str().unwrap();
                if let Some(parent) = parent.as_deref() {
                    ensure(child, Some(parent), false)?;
                } else if missing && !apply {
                    println!("missing {noun} {child} in {name}");
                }
            }
        }
        Ok(())
    }
}
