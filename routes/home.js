module.exports = function (router) {
    var homeRoute = router.route('/');

    homeRoute.get(function (req, res) {
        res.status(200).json({
            message: 'CS409 MP3 Task Management API is running',
            data: {
                status: 'OK'
            }
        });
    });

    return router;
};