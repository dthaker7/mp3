
/*
 * Connect all of your endpoints together here.
 */
module.exports = function (app, router) {
    app.use('/api', require('./home.js')(router));

    const usersRouter = require('express').Router();
    const tasksRouter = require('express').Router();

    app.use('/api/users', require('./users.js')(usersRouter));
    app.use('/api/tasks', require('./tasks.js')(tasksRouter));
};
