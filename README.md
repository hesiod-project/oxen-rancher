# Oxen Rancher
Used to be
```
        .o0l.
       ;kNMNo.
     ;kNMMXd'
   ;kNMMXd'                 .ld:             ,ldxkkkdl,.     'dd;     ,odl.  ;dd
 ;kNMMXo.  'ol.             ,KMx.          :ONXkollokXN0c.   cNMo   .dNNx'   dMW
dNMMM0,   ;KMMXo.           ,KMx.        .oNNx'      .dNWx.  :NMo .cKWk;     dMW
'dXMMNk;  .;ONMMXo'         ,KMx.        :NMx.         oWWl  cNWd;ON0:.      oMW
  'dXMMNk;.  ;kNMMXd'       ,KMx.        lWWl          :NMd  cNMNNMWd.       dMW
    'dXMMNk;.  ;kNMMXd'     ,KMx.        :NMx.         oWWl  cNMKolKWO,      dMW
      .oXMMK;   ,0MMMNd.    ,KMx.        .dNNx'      .dNWx.  cNMo  .dNNd.    dMW
        .lo'  'dXMMNk;.     ,KMXxdddddl.   :ONNkollokXN0c.   cNMo    ;OWKl.  dMW
            'dXMMNk;        .lddddddddo.     ,ldxkkkdl,.     'od,     .cdo;  ;dd
          'dXMMNk;
         .oNMNk;             L A U N C H E R
          .l0l.
```

# Requirements

- [nodejs](https://nodejs.org/en/) versions 8.x to 18.x are supported
- [npm](https://www.npmjs.com/get-npm) usually installed with nodejs (only for distribution and easy install of this software, we do not use ANY external NPMs for security reasons)
- Linux (though macos does works and Windows kind of works)
- xz (xz-utils apt package) to be able to download and extract updated Linux binaries
- setcap (apt: libcap2-bin, rpm: libcap) to be enable lokinet to not need to run as root on Linux

# Why use the rancher/launcher over DEBs
The goal of the launcher is to make it easier to run a service node, however the DEBs installation and upgrade process can be much easier if you're running a debian-based OS. However we do have some additional advantages:
- Safer, we have additional checks in configuration, like to make sure you don't create port conflicts. We also have other checks that can detect unwanted patterns of behavior between apps and be able to take action
- Easier config management, one config file to manage all 3 binaries, also reduces the chance of you having to resolve config conflicts during upgrades
- Firewall Notification, lets you know if you're blocking any required ports. DEBs will open them in ufw but this won't help if you're using an different or external firewall. 
- NAT support, Launcher automatically configures your outgoing interface and public IP. DEBs you have to manually set up your network interface and public ip. Neither will help you set up port forwarding though.
- Prequal tool, know for sure your situation meets our minimum requirements
- Easy to downgrade path: if an upgrade is causing you problems, you can manually pull older releases off github and replace the binaries in /opt/loki-launcher/bin and simply restart the launcher with the older binary until your node is stable.
- Diveristy of the network, in the highly unlikely event that Debian ever gets a serious bug, we want the service node network to be diverse enough to not be largely effective. Being able to support multiple operating systems is good for the Oxen(Loki) ecosystem.
- Robust distribution system: Launcher relies on Microsoft/GitHub infrastructure, the DEBs are ran by our developer on his server. You could argue Microsoft/GitHub has more people keeping an eye on security and availability of their system. (And while we use NPM to distribute oxen-rancher we do not use any NPM modules in this project)
- Interactive client sessions, so you don't have oxend start up delays for each command you want to run
- Unified subsystem reporting, get the status or versions of all 3 subsystems (blockchain, storage, network) from one command
- Works on Ubuntu 19.x, DEBs only work with 18LTS and 20LTS (Xenial 16.x was deprecated in a way to only support the debs and not the launcher)

Launcher was maintained at cost of the Loki Foundation and was unfunded. Please consider supporting this great tool by using it.

# How to do a fresh service node install

This will use npm to install the rancher

`sudo npm install -g oxen-rancher`

This will download and install the Oxen binaries for you if you don't already have them

`sudo oxen-rancher download-binaries`

This will create any needed directories and make sure everything has the proper permissions to run as a specified user such as `snode` in this example

`sudo oxen-rancher set-perms snode`

Now make sure sure you running the following commands as the user specified or you may run into permission problems (EPERM).

After it's installed, you can ask to prequalify your server to be a service node

`oxen-rancher prequal`

# How to use without systemd

`oxen-rancher start`

Running it once should start the suite of services into the background or give you a message why it can't. This isn't recommended for long term uses as there is nothing to restart launcher if it dies/exits.

Running `oxen-rancher client`, will give you an interactive terminal to oxend (the copy running from the current directory if you have multiple).
`exit` will stop your service node. If you just want to exit the interactive terminal, please use `ctrl-c`.

You can pass most [command line parameters](https://lokidocs.com/Advanced/lokid/) that you would give to oxend to `oxen-rancher start`

You can make a launcher config file in /etc/oxen-rancher/rancher.ini and change various settings, [Check our wiki](https://github.com/hesiod-project/oxen-rancher/wiki/Launcher.ini-configuration-documentation) for details on options.

# How to keep the rancher up to date

## Update your rancher without systemd

Stop your service node if it's running (you can use `oxen-rancher status` to check)

`oxen-rancher stop`

Update the launcher

`sudo npm install -g oxen-rancher`

And be sure to make sure you restart your service node (if it's staked) by

`oxen-rancher start`

## Get the latest Oxen software versions

`sudo oxen-rancher download-binaries`

And be sure to make sure you restart your service node (if it's staked) by

`oxen-rancher start`

## Other

[upgrading from lokid 3.0.6 with systemd to use the launcher](upgrading.md)

# Popular linux distribution instructions to install NodeJS

### CentOS NodeJS installation:

`curl -sL https://rpm.nodesource.com/setup_18.x | sudo bash -`

### Ubuntu/Debian NodeJS installation:

`curl -sL https://deb.nodesource.com/setup_18.x | sudo bash -`

then

`sudo apt-get install -y nodejs`



# Software the launcher manages

- [oxend](https://github.com/oxen-io/loki-core)
- [lokinet](https://github.com/oxen-io/loki-network)
- [oxen-storage](https://github.com/oxen-io/loki-storage-server)

To get the required software you can run `oxen-rancher download-binaries` and they will be placed in `/opt/loki-launcher/bin`

or

You can download the oxen binaries (faster) from each above page's release section

or

You can build from source. Make sure you select the correct repos/branches/versions as not all versions will work with each other.

And if you don't have the dependencies to build from source check out [contrib/dependency_helper/](contrib/dependency_helper/getDepsUnix.sh)

# Release Notes

Changelog items are now [available here](https://github.com/hesiod-project/oxen-rancher/releases)

# Donations

LVYAAirCt19PXLfA3ovvUnWq81oESv2iZXrbHUgW19Ff73aZSiZ6ZodSrukMrvVwUxGLyJed3su1YBXUZjww6SScS4z5xnj
