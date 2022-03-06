import * as cdk from '@aws-cdk/core';
import * as amplify from '@aws-cdk/aws-amplify';
import * as iam from '@aws-cdk/aws-iam';
import * as events from '@aws-cdk/aws-events';
import * as targets from '@aws-cdk/aws-events-targets';
import * as sns from '@aws-cdk/aws-sns';
import * as lambda from '@aws-cdk/aws-lambda';
import * as snsSubscription from '@aws-cdk/aws-sns-subscriptions';
import { BuildSpec } from 'aws-cdk-lib/aws-codebuild';
import { Branch } from '@aws-cdk/aws-amplify';
import { EventField } from '@aws-cdk/aws-events';
import * as fs from 'fs';
import { ServicePrincipal } from '@aws-cdk/aws-iam';

export class MainInfraStack extends cdk.Stack {
    constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // load env
        const appName = process.env.APP_NAME || '';
        const owner = process.env.OWNER || '';
        const repository = process.env.REPOSITORY || '';
        const token = process.env.GITHUB_TOKEN || '';
        const baseDomain = process.env.DOMAIN || '';
        const projectName = process.env.PROJECT_NAME || '';
        const slackWebhookURL = process.env.SLACK_WEBHOOK_URL || '';

        const amplifyApp = this.createAmplifyApp(appName, owner, repository, token, baseDomain, projectName);
        this.addDeployNotificationStack(amplifyApp, appName, slackWebhookURL);
    }

    private createAmplifyApp(
        appName: string,
        owner: string,
        repository: string,
        token: string,
        baseDomain: string,
        projectName: string,
    ) {
        const amplifyApp = new amplify.App(this, appName, {
            sourceCodeProvider: new amplify.GitHubSourceCodeProvider({
                owner: owner,
                repository: repository,
                oauthToken: cdk.SecretValue.plainText(token),
            }),
            autoBranchCreation: {
                patterns: ['develop', 'main', 'release*'],
            },
            autoBranchDeletion: true,
            role: this.createRole(projectName),
            buildSpec: this.getBuildSpec(),
        });

        const mainBranch = amplifyApp.addBranch('main');
        const developBranch = amplifyApp.addBranch('develop');

        amplifyApp.addCustomRule({
            source: '/<*>',
            target: '/index.html',
            status: amplify.RedirectStatus.NOT_FOUND_REWRITE,
        });

        const productionDomain = `${projectName}.${baseDomain}`;
        const stagingDomain = `staging-${productionDomain}`;
        this.createDomains(amplifyApp, mainBranch, productionDomain);
        this.createDomains(amplifyApp, developBranch, stagingDomain);

        return amplifyApp;
    }

    private createDomains(amplifyApp: amplify.App, branch: Branch, branchDomainName: string) {
        const domain = amplifyApp.addDomain(`${branchDomainName}`, {
            enableAutoSubdomain: false,
        });
        domain.mapRoot(branch); // map master branch to domain root
        domain.mapSubDomain(branch, 'www');
    }

    private createRole(projectName: string): iam.IRole {
        const role = new iam.Role(this, `cdk-amplify-role-${projectName}`, {
            assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
            description: `Custom role permitting resources creation from Amplify for ${projectName}`,
        });

        const iManagedPolicy = iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess-Amplify');

        role.addManagedPolicy(iManagedPolicy);
        return role;
    }

    private getBuildSpec(): BuildSpec {
        return BuildSpec.fromObjectToYaml({
            version: '1.0',
            frontend: {
                phases: {
                    preBuild: {
                        commands: ['yarn'],
                    },
                    build: {
                        commands: ['yarn run build'],
                    },
                },
                artifacts: {
                    baseDirectory: '.next',
                    files: -'**/*',
                },
                cache: {
                    paths: ['node_modules/**/*'],
                },
            },
        });
    }

    private addDeployNotificationStack(amplifyApp: amplify.App, appName: string, slackWebhookURL: string) {
        const rule = new events.Rule(this, 'rule', {
            eventPattern: {
                source: ['aws.amplify'],
                detail: {
                    appId: [amplifyApp.appId],
                    jobStatus: ['SUCCEED', 'FAILED', 'STARTED'],
                },
                detailType: ['Amplify Deployment Status Change'],
            },
        });

        const snsTopic = new sns.Topic(this, `sns-${appName}-deploy-topic`, {
            displayName: `${appName}`,
        });

        const lambdaFunction = this.createNotifyLambdaFunction(slackWebhookURL, appName, snsTopic);
        snsTopic.addSubscription(new snsSubscription.LambdaSubscription(lambdaFunction));

        this.createDeployNotificationRole(appName, snsTopic);
        rule.addTarget(
            new targets.SnsTopic(snsTopic, {
                message: events.RuleTargetInput.fromText(
                    `Hi, the build status for ${EventField.fromPath(
                        '$.detail.branchName',
                    )} branch with build ID ${EventField.fromPath(
                        '$.detail.jobId',
                    )} on ${appName} is ${EventField.fromPath('$.detail.jobStatus')}.`,
                ),
            }),
        );
    }

    private createNotifyLambdaFunction(slackWebhookURL: string, appName: string, snsTopic: sns.Topic): lambda.Function {
        const lambdaCode = fs.readFileSync('static/lambda-notify.js');

        const lambdaRole = new iam.Role(this, `iam-role-lambda-send-slack-notification-${appName}`, {
            roleName: `iam-role-lambda-send-slack-notification-${appName}`,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });

        // policy to allow assume role TenantUserRole
        lambdaRole.addToPolicy(
            new iam.PolicyStatement({
                resources: ['*'],
                actions: ['sts:AssumeRole'],
            }),
        );

        const fn = new lambda.Function(this, `sendSlackNotification${appName}`, {
            runtime: lambda.Runtime.NODEJS_12_X,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`${lambdaCode.toString()}`),
            environment: { WEBHOOK_URL: slackWebhookURL },
            role: lambdaRole,
        });

        fn.addPermission(`sendSlack${appName}-execution-permission`, {
            action: 'lambda:InvokeFunction',
            principal: new ServicePrincipal('sns.amazonaws.com'),
            sourceArn: snsTopic.topicArn,
        });

        return fn;
    }

    private createDeployNotificationRole(appName: string, snsTopic: sns.Topic): iam.IRole {
        const role = new iam.Role(this, `cdk-amplify-notification-role-${appName}`, {
            assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
            description: `Custom role permitting event publishing from Amplify for ${appName}`,
        });

        const inlinePolicy = new iam.Policy(this, `cdk-amplify-deploy-notification-policy-${appName}`, {
            statements: [
                new iam.PolicyStatement({
                    actions: ['SNS:Publish'],
                    resources: [snsTopic.topicArn],
                }),
            ],
        });

        role.attachInlinePolicy(inlinePolicy);
        return role;
    }
}
