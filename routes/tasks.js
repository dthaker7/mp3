
const mongoose = require('mongoose');
const Task = require('../models/task');
const User = require('../models/user');

module.exports = function (router) {
    function fail(status, message) {
        const error = new Error(message);
        error.status = status;
        throw error;
    }

    function handleError(res, error) {
        const status = error.status ||
            (error instanceof SyntaxError ||
             error.name === 'ValidationError' ||
             error.name === 'CastError' ||
             error.code === 11000 ? 400 : 500);

        if (status === 500) console.error(error);

        return res.status(status).json({
            message: error.status ? error.message :
                status === 400 ? 'Invalid request' : 'Internal server error',
            data: null
        });
    }

    function parseJSON(value, fallback) {
        return value === undefined ? fallback : JSON.parse(value);
    }

    function validateBody(body) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            fail(400, 'Invalid task data');
        }

        if (typeof body.name !== 'string' || !body.name.trim()) {
            fail(400, 'A valid task name is required');
        }

        if (body.deadline === undefined ||
            body.deadline === null ||
            body.deadline === '' ||
            Number.isNaN(new Date(body.deadline).getTime())) {
            fail(400, 'A valid deadline is required');
        }

        if (body.description !== undefined &&
            typeof body.description !== 'string') {
            fail(400, 'Description must be a string');
        }

        if (body.completed !== undefined &&
            typeof body.completed !== 'boolean') {
            fail(400, 'Completed must be a boolean');
        }

        if (body.assignedUser !== undefined &&
            (typeof body.assignedUser !== 'string' ||
             (body.assignedUser !== '' &&
              !mongoose.isValidObjectId(body.assignedUser)))) {
            fail(400, 'Invalid assigned user ID');
        }

        if (body.assignedUserName !== undefined &&
            typeof body.assignedUserName !== 'string') {
            fail(400, 'Invalid assigned user name');
        }
    }

    async function resolveUser(body, session) {
        const userId = body.assignedUser || '';

        if (!userId) {
            if (body.assignedUserName !== undefined &&
                body.assignedUserName !== 'unassigned') {
                fail(400, 'Unassigned tasks must use unassigned as the name');
            }
            return null;
        }

        const user = await User.findById(userId).session(session);
        if (!user) fail(404, 'Assigned user does not exist');

        if (body.assignedUserName !== undefined &&
            body.assignedUserName !== user.name) {
            fail(400, 'Assigned user name does not match');
        }

        return user;
    }

    function taskFields(body, user) {
        return {
            name: body.name,
            description: body.description ?? '',
            deadline: body.deadline,
            completed: body.completed ?? false,
            assignedUser: user ? user._id.toString() : '',
            assignedUserName: user ? user.name : 'unassigned'
        };
    }

    async function synchronize(task, session) {
        const taskId = task._id.toString();

        await User.updateMany(
            { pendingTasks: taskId },
            { $pull: { pendingTasks: taskId } },
            { session }
        );

        if (task.assignedUser && !task.completed) {
            await User.updateOne(
                { _id: task.assignedUser },
                { $addToSet: { pendingTasks: taskId } },
                { session }
            );
        }
    }

    // GET /api/tasks
    router.get('/', async (req, res) => {
        try {
            const where = parseJSON(req.query.where, {});
            const sort = parseJSON(req.query.sort, {});
            const select = parseJSON(req.query.select, {});

            const skip = req.query.skip === undefined
                ? 0 : Number(req.query.skip);
            const limit = req.query.limit === undefined
                ? 100 : Number(req.query.limit);

            if (!Number.isInteger(skip) || skip < 0 ||
                !Number.isInteger(limit) || limit < 0) {
                fail(400, 'Invalid pagination');
            }

            if (req.query.count === 'true') {
                const count = await Task.countDocuments(where);
                return res.status(200).json({
                    message: 'Task count retrieved',
                    data: count
                });
            }

            const query = Task.find(where)
                .sort(sort)
                .select(select)
                .skip(skip);

            if (limit > 0) query.limit(limit);

            return res.status(200).json({
                message: 'Tasks retrieved',
                data: await query.exec()
            });
        } catch (error) {
            return handleError(res, error);
        }
    });

    // POST /api/tasks
    router.post('/', async (req, res) => {
        try {
            validateBody(req.body);
            let createdTask;

            await mongoose.connection.transaction(async session => {
                const user = await resolveUser(req.body, session);

                const tasks = await Task.create(
                    [taskFields(req.body, user)],
                    { session }
                );

                createdTask = tasks[0];
                await synchronize(createdTask, session);
            });

            return res.status(201).json({
                message: 'Task created',
                data: createdTask
            });
        } catch (error) {
            return handleError(res, error);
        }
    });

    // GET /api/tasks/:id
    router.get('/:id', async (req, res) => {
        try {
            if (!mongoose.isValidObjectId(req.params.id)) {
                fail(404, 'Task not found');
            }

            const select = parseJSON(req.query.select, {});
            const task = await Task.findById(req.params.id)
                .select(select);

            if (!task) fail(404, 'Task not found');

            return res.status(200).json({
                message: 'Task retrieved',
                data: task
            });
        } catch (error) {
            return handleError(res, error);
        }
    });

    // PUT /api/tasks/:id
    router.put('/:id', async (req, res) => {
        try {
            if (!mongoose.isValidObjectId(req.params.id)) {
                fail(404, 'Task not found');
            }

            let updatedTask;

            await mongoose.connection.transaction(async session => {
                const task = await Task.findById(req.params.id)
                    .session(session);

                if (!task) fail(404, 'Task not found');

                validateBody(req.body);
                const user = await resolveUser(req.body, session);
                const fields = taskFields(req.body, user);

                Object.assign(task, fields);
                await task.save({ session });
                await synchronize(task, session);

                updatedTask = task;
            });

            return res.status(200).json({
                message: 'Task updated',
                data: updatedTask
            });
        } catch (error) {
            return handleError(res, error);
        }
    });

    // DELETE /api/tasks/:id
    router.delete('/:id', async (req, res) => {
        try {
            if (!mongoose.isValidObjectId(req.params.id)) {
                fail(404, 'Task not found');
            }

            await mongoose.connection.transaction(async session => {
                const task = await Task.findById(req.params.id)
                    .session(session);

                if (!task) fail(404, 'Task not found');

                await User.updateMany(
                    { pendingTasks: task._id.toString() },
                    { $pull: {
                        pendingTasks: task._id.toString()
                    }},
                    { session }
                );

                await Task.deleteOne(
                    { _id: task._id },
                    { session }
                );
            });

            return res.status(204).send();
        } catch (error) {
            return handleError(res, error);
        }
    });

    return router;
};
