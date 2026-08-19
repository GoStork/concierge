# Production host deploy scripts

`gostork-deploy.sh` is the pull-based auto-deployer installed on the production
VM `gostork-2-prod` as `/usr/local/bin/gostork-deploy` (run by
`gostork-deploy.timer` every minute). This copy is the source of truth - after
editing it here, reinstall on the host:

    gcloud compute scp deploy/gostork-deploy.sh gostork-2-prod:/tmp/gostork-deploy --project=gostork --zone=us-east4-b --tunnel-through-iap
    gcloud compute ssh gostork-2-prod --project=gostork --zone=us-east4-b --tunnel-through-iap -- sudo install -m 755 /tmp/gostork-deploy /usr/local/bin/gostork-deploy

See docs/production-launch-runbook.md section 0.5 for the host layout.
