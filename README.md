# Amplify CDK + slack notifications on build

This is a project for setting up an Amplify app for NextJS application with CDK.
This also sets up deploy notifications for every build triggered on amplify with the status of the build.
A lambda function is triggered whenever a build is triggered. Currently the lambda is configured to post to a SLACK WEBHOOK.

It uses cdk 1.*.* currently, will migrate this to v2 shortly.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `yarn run build`   compile typescript to js
* `yarn run watch`   watch for changes and compile
* `yarn run test`    perform the jest unit tests
* `cdk deploy`      deploy this stack to your default AWS account/region
* `cdk diff`        compare deployed stack with current state
* `cdk synth`       emits the synthesized CloudFormation template
