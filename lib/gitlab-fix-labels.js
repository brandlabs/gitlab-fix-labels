#!/usr/bin/env nodejs

const ACTION_ADD = 'add';
const ACTION_DELETE = 'delete';
const ACTION_REPLACE = 'replace';

const KEYWORD_ALL = 'all';

const _DESCRIPTION =
`This tool will help propagate into the repos of your choice those nice shiny
new global admin labels you worked so hard on. See below.

To get a help message (or use unexpected syntax):
gitlab-fix-labels

General command syntax:
gitlab-fix-labels GITLAB_API_STARTPOINT_URI YOUR_AUTH_TOKEN YOUR_ACTION YOUR_TARGET

Possible actions:

${ACTION_ADD} - add your admin labels to your target repo(s); existing labels
will not be touched; any duplicates will be skipped.

${ACTION_DELETE} - completely and utterly delete all of a repository's labels.

${ACTION_REPLACE} - the same as calling "${ACTION_DELETE}" followed by "${ACTION_ADD}".

Your target:

The target must either be the string "${KEYWORD_ALL}" (case sensitive, no quotes)
or an integer larger than 0.

Example invocations:
gitlab-fix-labels https://git.mysite.org/api/v4 myspecial_tokenhere ${ACTION_ADD} 10
gitlab-fix-labels https://newgitlab.com/api/v5 my2ndspecial_tokenhere ${ACTION_DELETE} ${KEYWORD_ALL}
gitlab-fix-labels http://git.lol/api/v4/ myotherspecial_tokenhere ${ACTION_REPLACE} ${KEYWORD_ALL}
gitlab-fix-labels http://git.lol/api/v5/ special_token2 ${ACTION_REPLACE} 555

To completely replace the labels on one project with your custom admin global
defaults (set in the administrator area of GitLab):
gitlab-fix-labels GITLAB_API_STARTPOINT_URI YOUR_AUTH_TOKEN ${ACTION_REPLACE} YOUR_TARGET

To completely replace the labels on ALL projects with your global admin defaults:
gitlab-fix-labels GITLAB_API_STARTPOINT_URI YOUR_AUTH_TOKEN ${ACTION_REPLACE} ${KEYWORD_ALL}

To append your global admin defaults to ALL projects (not deleting existing labels):
gitlab-fix-labels GITLAB_API_STARTPOINT_URI YOUR_AUTH_TOKEN ${ACTION_ADD} ${KEYWORD_ALL}

XXX: Note: this tool arbitrarily limits itself to dealing with 100 labels or
less. If your project needs more labels than this, then... wow!`;

Promise = require('bluebird');
const ProgressBar = require('progress');
const request = require('request-promise');
const crypto = require('crypto');

const retryLimit = 3;
const retryDelayMs = 100;

const requestDefaults = {
    method: 'GET',
    json: true,
    page: 1,
    per_page: 100, // eslint-disable-line camelcase
};

const api = {
    dummyProjectId: -1,
    dummyProjectLabels: [],
    uriFrag: null,
    ignoreParseError: false,
};

const uniqueName = crypto.createHash('sha1').update(JSON.stringify(new Date())).digest('hex');

const progressBar = new ProgressBar('[:bar] :percent (:elapseds elapsed)',
{
    complete: '=',
    incomplete: ' ',
    width: 40,
    total: 100,
});

const isUsingTTY = process && process.stdout && process.stdout.isTTY;

/**
 * Calls or execute a callable if the condition evaluates to true
 *
 * @param {function} callable   A function that will be called if condition is truthy.
 * @param {boolean}  condition  Condition that if it evaluates to true, callable will be called
 *
 */
const optionalCall = (callable, condition) => {
    if (condition) {
        callable();
    }
};

request.andKeepRetrying = async (options) =>
{
    let failed = false;
    let failcount = 0;
    let failtime = retryDelayMs;
    let response = null;

    do
    {
        try
        {
            failed = false;
            response = await Promise.delay(failtime).then(() => request(options));
        }

        catch(e)
        {
            if(api.ignoreParseError && e.message === 'Error: Parse Error' && e.options.method === 'DELETE')
                failed = false;

            else if(e.error.message === '404 Label Not Found')
            {
                optionalCall(() => {
                    progressBar.interrupt(
                        `<${Date.now()}> IGNORING parse error HPE_INVALID_CONSTANT. With the previous
                            request, GitLab erroneously returned more data than it told Node to expect. This
                            GitLab problem will be ignored for the remainder of execution.`);
                }, isUsingTTY);

                api.ignoreParseError = true;
            }

            else
            {
                failed = true;
                failtime += retryDelayMs;

                if(++failcount > retryLimit)
                    throw e;

                optionalCall(() => {
                    progressBar.interrupt(`<${Date.now()}> RETRYING failed request in ${failtime}ms...`);
                }, isUsingTTY);
            }
        }
    } while(failed);

    return response;
};

api.createDummyProject = async () =>
{
    /*if(api.dummyProjectId !== -1)
        throw 'createDummyProject called while dummy project already exists!';

    const result = await request.andKeepRetrying(Object.assign({}, requestDefaults,
    {
        method: 'POST',
        url: api.uriFrag + `projects`,
        body: {
            visibility: 'private',
            name: `deleteme-${uniqueName}`,
            issues_enabled: true, // eslint-disable-line camelcase
        }
    }));

    return api.dummyProjectId = result.id;*/
    return api.dummyProjectId = process.env.DUMMY_PROJECT;
};

/*api.deleteDummyProject = () =>
{
    if(api.dummyProjectId === -1)
        throw 'deleteDummyProject called before createDummyProject';

    return request.andKeepRetrying(Object.assign({}, requestDefaults,
    {
        method: 'DELETE',
        url: api.uriFrag + `projects/${api.dummyProjectId}`,
    })).then(() => api.dummyProjectId = -1);
};*/

api.getDummyProjectLabels = async () =>
{
    if(api.dummyProjectLabels.length)
        return api.dummyProjectLabels;

    if(api.dummyProjectId === -1)
        throw 'getDummyProjectLabels called before createDummyProject';

    return api.dummyProjectLabels = await api.getProjectLabels(api.dummyProjectId);
};

api.getProjectLabels = (projectId) =>
{
    return request.andKeepRetrying(Object.assign({}, requestDefaults,
    {
        url: api.uriFrag + `projects/${projectId}/labels?per_page=200`,
    }));
};

api.deleteProjectLabels = async (projectId) =>
{
    const labels = await api.getProjectLabels(projectId);

    return Promise.each(labels, async label =>
    {
        await request.andKeepRetrying(Object.assign({}, requestDefaults,
        {
            method: 'DELETE',
            url: api.uriFrag + `projects/${projectId}/labels`,
            qs: {
                name: label.name
            }
        }));
    });
};

api.copyDummyProjectLabelsTo = async (toProjectId, addDuplicates) =>
{
    const ourLabels = await api.getProjectLabels(toProjectId);
    const ourLabelNames = ourLabels.map(l => l.name);
    const dummyLabels = (await api.getDummyProjectLabels()).filter(l => ourLabels.find(o => o.name === l.name && o.color === l.color) === undefined);

    return Promise.each(dummyLabels, async label =>
    {
        await request.andKeepRetrying(Object.assign({}, requestDefaults,
        {
            method: ourLabelNames.includes(label.name) ? 'PUT' : 'POST',
            url: api.uriFrag + `projects/${toProjectId}/labels`,
            qs: {
                name: label.name,
                color: label.color,
                description: label.description,
            }
        }));
    });
};

api.cleanupProjectLabelsTo = async (toProjectId) =>
{
    const ourLabels = await api.getProjectLabels(toProjectId);
    const dummyLabelNames = (await api.getDummyProjectLabels()).map(l => l.name);
    const removeLabels = ourLabels.filter(label => !dummyLabelNames.includes(label.name));

    return Promise.each(removeLabels, async label =>
    {
        await request.andKeepRetrying(Object.assign({}, requestDefaults,
        {
            method: 'DELETE',
            url: api.uriFrag + `projects/${toProjectId}/labels`,
            qs: {
                name: label.name
            }
        }));
    });
};

api.getAllProjectIds = async () =>
{
    if(!api.getAllProjectIds.ids)
    {
        let interimResults = false;
        let page = 0;

        api.getAllProjectIds.ids = [];

        const resultsIter = project =>
        {
            if(project.id !== api.dummyProjectId)
            {
                interimResults = true;
                api.getAllProjectIds.ids.push(project.id);
            }
        };

        do
        {
            interimResults = false;

            const results = await request.andKeepRetrying(Object.assign({}, requestDefaults,
            {
                url: api.uriFrag + `projects`,
                qs: {
                    order_by: 'id', // eslint-disable-line camelcase
                    simple: true,
                    page: ++page,
                }
            }));

            results.forEach(resultsIter);

        } while(interimResults);
    }

    return api.getAllProjectIds.ids;
};

let error = false;

(async () =>
{
    const apiStartpointUri = process.argv[2];
    const apiAuthToken = process.argv[3];
    const action = process.argv[4];
    const rawTargetProjectId = process.argv[5];
    const targetProjectId = parseInt(rawTargetProjectId, 10) || 0;

    if(apiStartpointUri && apiAuthToken && action && (rawTargetProjectId === KEYWORD_ALL || targetProjectId > 0 ))
    {
        api.uriFrag = apiStartpointUri + (apiStartpointUri[apiStartpointUri.length - 1] === '/' ? '' : '/');
        requestDefaults.headers = { 'PRIVATE-TOKEN': apiAuthToken };

        const suffix = (targetProjectId ? `project id #"${targetProjectId}"` : 'all projects') + '...';

        const allowedOperations = {
            addAdminLabels: false,
            addDuplicates: true,
            deleteLabelsFirst: false,
            cleanupLabels: false
        }

        if(action === ACTION_ADD)
        {
            console.info('Attempting to add labels (skipping duplicates) to', suffix);
            allowedOperations.addAdminLabels = true;
        }

        else if(action === ACTION_DELETE)
        {
            console.info('Attempting to delete all labels on', suffix);
            allowedOperations.deleteLabelsFirst = true;
        }

        else if(action === ACTION_REPLACE)
        {
            console.info('Attempting to delete and replace all labels on', suffix);
            //allowedOperations.deleteLabelsFirst = true;
            allowedOperations.addAdminLabels = true;
            allowedOperations.cleanupLabels = true;
        }

        else
        {
            console.error(`ERROR: Unrecognized action "${action}"`);
            console.info(_DESCRIPTION);
            console.error(`ERROR: Unrecognized action "${action}"`);

            return;
        }

        const interval = setInterval(() => {
            optionalCall(() => { progressBar.render(); }, isUsingTTY);
        }, 200);

        try
        {
            optionalCall(() => { progressBar.tick(1); }, isUsingTTY);

            await api.createDummyProject();

            optionalCall(() => { progressBar.tick(19); }, isUsingTTY);

            await api.getDummyProjectLabels();

            optionalCall(() => { progressBar.tick(20); }, isUsingTTY);

            if(targetProjectId)
            {
                if(allowedOperations.deleteLabelsFirst)
                    await api.deleteProjectLabels(targetProjectId);

                optionalCall(() => { progressBar.tick(19); }, isUsingTTY);

                if(allowedOperations.cleanupLabels)
                    await api.cleanupProjectLabelsTo(targetProjectId);

                optionalCall(() => { progressBar.tick(20); }, isUsingTTY);

                if(allowedOperations.addAdminLabels)
                    await api.copyDummyProjectLabelsTo(targetProjectId, allowedOperations.addDuplicates);

                optionalCall(() => { progressBar.tick(20); }, isUsingTTY);
            }

            else
            {
                const projectIds = await api.getAllProjectIds();

                optionalCall(() => { progressBar.tick(20); }, isUsingTTY);

                const tock = 39 / projectIds.length;

                await Promise.each(projectIds, async projectId =>
                {
                    try
                    {
                        if(allowedOperations.deleteLabelsFirst)
                            await api.deleteProjectLabels(projectId);

                        if(allowedOperations.cleanupLabels)
                            await api.cleanupProjectLabelsTo(projectId);

                        if(allowedOperations.addAdminLabels)
                            await api.copyDummyProjectLabelsTo(projectId, allowedOperations.addDuplicates);
                    }

                    catch(e)
                    {
                        optionalCall(() => {
                            progressBar.interrupt(`<${Date.now()}> FAILURE for #"${projectId}": (${e})`);
                        }, isUsingTTY);
                    }

                    optionalCall(() => { progressBar.tick(tock); }, isUsingTTY);
                });
            }

            //await api.deleteDummyProject();
            optionalCall(() => { progressBar.tick(1); }, isUsingTTY);

            clearInterval(interval);
            optionalCall(() => { progressBar.render(); }, isUsingTTY);
            optionalCall(() => { progressBar.terminate(); }, isUsingTTY);

            console.info('Done!');
        }

        catch(e)
        {
            optionalCall(() => {
                progressBar.interrupt(`<${Date.now()}> FATAL error: ${e}`);
            }, isUsingTTY);
            error = true;
        }

        finally
        {
            if(error)
            {
                //await api.deleteDummyProject();

                clearInterval(interval);
                optionalCall(() => { progressBar.render(); }, isUsingTTY);
                optionalCall(() => { progressBar.terminate(); }, isUsingTTY);

                console.info('(removed dummy project)');
            }
        }
    }

    else
        console.info(_DESCRIPTION);
})();
