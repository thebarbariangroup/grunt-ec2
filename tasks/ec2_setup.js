'use strict';

var _ = require('lodash');
var fs = require('fs');
var path = require('path');
var util = require('util');
var chalk = require('chalk');
var mustache = require('mustache');
var conf = require('./lib/conf.js');
var remote = require('./lib/remote.js');

module.exports = function(grunt){

    grunt.registerTask('ec2_setup', function(name){
        conf.init(grunt);

        if (arguments.length === 0) {
            grunt.fatal([
                'You should provide an instance name.',
                'e.g: ' + chalk.yellow('grunt ec2_setup:name')
            ].join('\n'));
        }

        function iif (value, commands) {
            return conf(value) ? commands : [];
        }

        // TODO rsync user, node user, nginx user?

        var done = this.async();
        var project = conf('PROJECT_ID');
        var cert = conf('SRV_RSYNC_CERT');
        var certStore = conf('SRV_CERT');
        var latest = conf('SRV_RSYNC_LATEST');
        var versions = conf('SRV_VERSIONS');
        var tasks = [[
            util.format('echo "configuring up %s instance..."', name)
        ], [ // forward port 80
            forwardPort(80, 8080)
        ], iif('SSL_ENABLED', // forward port 443
            forwardPort(443, 8433)
        ), [ // rsync
            util.format('sudo mkdir -p %s', versions),
            util.format('sudo mkdir -p %s', cert),
            util.format('sudo chown ubuntu %s', cert),
            util.format('sudo mkdir -p %s', latest),
            util.format('sudo chown ubuntu %s', latest)
        ], iif('SSL_ENABLED', // create cert store
            util.format('sudo mkdir -p %s', certStore)
        ), iif('SSL_ENABLED', { // send certificates
            rsync: {
                name: 'cert',
                local: process.cwd(),
                remote: conf('SRV_RSYNC_CERT'),
                dest: conf('SRV_CERT'),
                includes: [
                    conf('SSL_CERTIFICATE'),
                    conf('SSL_CERTIFICATE_KEY')
                ],
                excludes: ['*']
            }
        }), iif('NGINX_ENABLED', // nginx
            nginxConf()
        ), [ // node.js
            'sudo apt-get install python-software-properties',
            'sudo add-apt-repository ppa:chris-lea/node.js -y',
            'sudo apt-get update',
            'sudo apt-get install nodejs -y'
        ], [ // pm2
            'sudo apt-get install make g++ -y',
            'sudo npm install -g pm2',
            'sudo pm2 startup'
        ]];

        function forwardPort(from, to) {
            return [
                'cp /etc/sysctl.conf /tmp/',
                'echo "net.ipv4.ip_forward = 1" >> /tmp/sysctl.conf',
                'sudo cp /tmp/sysctl.conf /etc/',
                'sudo sysctl -p /etc/sysctl.conf',
                util.format('sudo iptables -A PREROUTING -t nat -i eth0 -p tcp --dport %s -j REDIRECT --to-port %s', from, to),
                util.format('sudo iptables -A INPUT -p tcp -m tcp --sport %s -j ACCEPT', from),
                util.format('sudo iptables -A OUTPUT -p tcp -m tcp --dport %s -j ACCEPT', from),
                'sudo iptables-save'
            ];
        }

        function nginxTemplate (name, where) {
            var conf = util.format('%s/%s.conf', conf('SRV_ROOT'), name);
            var local = path.resolve(__dirname, util.format('../cfg/%s.conf', name));
            var template = fs.readFileSync(local, { encoding: 'utf8' });
            var data = mustache.render(template, conf());
            var escaped = data
                .replace(/"/g, '\\"')
                .replace(/\$/g, '\\$');

            return [
                util.format('sudo touch %s', conf),
                util.format('sudo chown ubuntu %s', conf),
                util.format('sudo ln -sfn %s /etc/nginx/%s.conf', conf, where),
                util.format('echo "%s" > %s', escaped, conf)
            ];
        }

        function nginxConf () {
            return [
                'sudo add-apt-repository ppa:chris-lea/nginx-devel -y',
                'sudo apt-get update',
                'sudo apt-get install nginx nginx-common nginx-full -y',
                nginxTemplate('http', 'nginx'),
                nginxTemplate('server', 'sites-enabled/' + project),
                'sudo service nginx start || (cat /var/log/nginx/error.log && exit 1)'
            ];
        }

        var commands = _.flatten(tasks);
        remote(commands, name, done);
    });
};