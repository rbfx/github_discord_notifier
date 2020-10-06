const core = require('@actions/core');
const github = require('@actions/github');
const axios = require('axios').default;
const _ = require('lodash');

if (github.context.eventName != 'push')
    return;

_.templateSettings.interpolate = /{{([\s\S]+?)}}/g;

// Common context.
let branch_or_tag = github.context.ref.startsWith('refs/heads/')
    ? github.context.ref.slice(11)
    : (github.context.ref.startsWith('refs/tags/')
        ? github.context.ref.slice(10)
        : github.context.ref
    );
let $context_base =
{
    env: { ...process.env },
    github: {
        ...github,
        branch: branch_or_tag,
        branch_url: `https://github.com/${github.context.payload.repository.full_name}/tree/${branch_or_tag}`
    },
};

// Set up commit title/message.
function SplitCommitMessage(commit)
{
    let msg = commit.message;
    let nn = msg.indexOf('\n\n');
    commit.title = nn >= 0 ? msg.slice(0, nn) : msg;
    commit.description = nn >= 0 ? msg.slice(nn + 2) : ''
}
SplitCommitMessage(github.context.payload.head_commit);
github.context.payload.commits.map(SplitCommitMessage);

function IsAccepted($context)
{
    let discord_commit_filter = core.getInput('discord-filter');
    if (discord_commit_filter)
    {
        let filter_expr = _.template(discord_commit_filter)($context);
        try
        {
            if (!eval(filter_expr))
            {
                console.log(`Filtered out because expression evaluated to false: ${filter_expr}`);
                return false;
            }
        }
        catch (e)
        {
            if (typeof e == SyntaxError)
                throw `Syntax error in discord-filter. It should be a valid JS expression.\nInvalid expression: ${filter_expr}`;
            else
                throw e;
        }
    }
    return true;
}

function PrepareDiscordMessage(msg_payload, content_template, embed_template, $context)
{
    content_template = content_template ? core.getInput(content_template) : '';
    if (content_template)
        msg_payload['content'] = _.template(content_template)($context);

    embed_template = embed_template ? core.getInput(embed_template) : embed_template;
    if (embed_template)
    {
        var embed;
        try
        {
            embed = JSON.parse(_.template(embed_template)($context));
        }
        catch (e)
        {
            console.log('JSON syntax error in:');
            console.log(embed_template);
            throw e;
        }
        if ('color' in embed)
            embed.color = parseInt(embed.color);
        if (!('embeds' in msg_payload))
            msg_payload['embeds'] = [];
        msg_payload.embeds.push(embed);
    }
}

async function SendDiscordMessage(payload)
{
    let discord_webhook = core.getInput('discord-webhook');
    let discord_username = core.getInput('discord-username');
    let discord_avatar_url = core.getInput('discord-avatar-url');

    // No webhook == no discord support
    if (!discord_webhook)
    {
        console.log('No discord webhook URL == no discord messages.');
        return;
    }

    if (discord_username)
        payload.username = discord_username;

    if (discord_avatar_url)
        payload.avatar_url = discord_avatar_url;

    let embeds = payload['embeds'] || [];
    delete payload['embeds'];

    for (var i = 0; i < Math.max(embeds.length, 1); i += 10)
    {
        // Discord allows up to 10 embeds in one message. Either split embeds or send one message without them.
        if (embeds.length > 0)
            payload['embeds'] = embeds.slice(i, i + 10);

        let response = await axios({
            url: `${discord_webhook}?wait=true`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: payload
        });

        delete payload['embeds'];
        delete payload['content'];  // Only send content in the first message. After that send only embeds.
    
        if (response.status != 200 && response.status != 204)
            console.log(`Discord: error=${response.status} -> ${response.data}`);
    }
}

async function PublishDiscordCommits()
{
    // Send commits to discord
    for (var i = 0; i < github.context.payload.commits.length; i++)
    {
        let commit = github.context.payload.commits[i];
        let $context = {
            ...$context_base,
            commit: { ...commit },
        };

        // Filter out undesired commits.
        if (!IsAccepted($context))
            continue;

        let payload = { timestamp: commit.timestamp };
        PrepareDiscordMessage(payload, 'discord-commit-message', 'discord-commit-embed', $context);
        await SendDiscordMessage(payload);
    }
}

async function PublishDiscordJobs()
{
    const octokit = github.getOctokit(core.getInput('github-token'));

    let runs = await octokit.request('GET /repos/{owner}/{repo}/actions/runs',
    {
        owner: github.context.payload.repository.owner.name,
        repo: github.context.payload.repository.name
    });

    if (runs.status != 200)
        throw task_jobs.data;
    
    // Find current and previous runs of same workflow job.
    var this_run = undefined, last_run = undefined;
    for (var i = 0; i < runs.data.workflow_runs.length; i++)
    {
        let run = runs.data.workflow_runs[i];
        if (run.id == github.context.runId)
            this_run = run;
        else if (this_run != undefined)
        {
            if (run.conclusion != 'success' && run.conclusion != 'failure')
                continue;

            if (this_run.workflow_id == run.workflow_id && run.id != this_run.id)
            {
                last_run = run;
                break;
            }
        }
    }

    if (!this_run)
        throw 'Could not find current run.';

    if (!last_run)
    {
        if (github.context.runNumber > 1)
            console.log('Could not find previous run.');
        return;
    }

    let task_jobs = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', {
        owner: github.context.payload.repository.owner.name,
        repo: github.context.payload.repository.name,
        run_id: this_run.id
    });

    if (task_jobs.status != 200)
        throw task_jobs.data;

    // Estimate current job conclusion.
    this_run.conclusion = 'success';
    for (var i = 0; i < task_jobs.data.jobs.length; i++)
    {
        let job = task_jobs.data.jobs[i];
        if (job.conclusion == 'failure')
        {
            this_run.conclusion = 'failure';
            break;
        }
    }

    if (this_run.conclusion == 'success')
    {
        // Report succeeding jobs
        let $context = {
            ...$context_base,
            run: { ...this_run },
            last_run: { ...last_run },
        };

        // Filter out undesired job runs.
        if (!IsAccepted($context))
            return;
        
        var payload = {};
        PrepareDiscordMessage(payload, 'discord-job-fixed-failure-message', 'discord-job-fixed-failure-embed', $context);
        await SendDiscordMessage(payload);
    }
    else if (this_run.conclusion == 'failure')
    {
        // Report failing jobs
        var payload = {};
        var send_message = false;
        for (var i = 0; i < task_jobs.data.jobs.length; i++)
        {
            let job = task_jobs.data.jobs[i];
            if (job.conclusion == 'failure')
            {
                var failing_steps = '';
                for (var j = 0; j < job.steps.length; j++)
                {
                    let step = job.steps[j];
                    if (step.conclusion == 'failure')
                        failing_steps += (failing_steps.length > 0 ? ', ' : '') + step.name;
                }
                let $context =
                {
                    ...$context_base,
                    job: { ...job, url: `https://github.com/${github.context.payload.repository.full_name}/runs/${job.run_id}` },
                    run: { ...this_run },
                    last_run: { ...last_run },
                    failing_steps: failing_steps
                }

                // Filter out undesired job runs.
                if (!IsAccepted($context))
                    continue;
                
                PrepareDiscordMessage(payload, 'discord-job-new-failure-message', 'discord-job-new-failure-embed', $context);
                send_message = true;
            }   
        }

        if (send_message)
            await SendDiscordMessage(payload);
    }
}

let tasks =
{
    'discord-commits': PublishDiscordCommits,
    'discord-jobs': PublishDiscordJobs,
};

for (const action of core.getInput('action-task').split(','))
{
    tasks[action]().then(() => { }).catch((e) => {
        console.error(e);
        core.setFailed(e);
    });
}
