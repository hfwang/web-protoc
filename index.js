var Busboy = require("busboy");
var async = require("async");
var bodyParser = require("body-parser");
var child_process = require("child_process");
var ejs = require("ejs");
var express = require("express");
var fs = require("fs");
var inspect = require('util').inspect;
var logfmt = require("logfmt");
var path = require("path");
var rimraf = require("rimraf");
var tmp = require("tmp");
var unzip = require("unzip");

var app = express();

app.use(logfmt.requestLogger());
app.use(bodyParser());

// process.on('uncaughtException', function(err) {
//   console.log('Caught exception: ' + inspect(err));
//   console.log(err.stack);
// });

var INDEX_TEMPLATE = ejs.compile([
  "<h1>Web Protoc</h1>",
  "<p>This is a web frontend to run the Google Protocol Buffer compiler, ",
  'since building it yourself might be "hard".</p>',
  '<form action="compile" enctype="multipart/form-data" method="post">',
  '<b>Input zip file</b><br />',
  '<input type="file" name="input" /><br />',
  "<b>Output:</b><br />",
  "<label><input type='radio' name='output' value='java' /> Java</label><br />",
  "<label><input type='radio' name='output' value='cpp' /> C++</label><br />",
  "<label><input type='radio' name='output' value='python' /> Python</label><br />",
  "<label><input type='radio' name='output' value='ruby' /> Ruby</label> [<a href='https://github.com/localshred/protobuf'>?</a>]<br />",
  "<label><input type='radio' name='output' value='descriptor' /> Protobuf Descriptor</label><br />",
  '<button type="submit">Compile</button>',
  "</form>"
].join("\n"));
app.get('/', function(req, res) {
  res.send(INDEX_TEMPLATE({}));
});

var COMPILE_QUEUE = async.queue(function(task, cb) {
  COMPILE_QUEUE.total_run += 1;
  // console.log("Executing: " + inspect(task));
  var args = [];
  switch(task.output) {
    case "java":
      args = ["--java_out=" + task.output_path];
    break;
    case "cpp":
      args = ["--cpp_out=" + task.output_path];
    break;
    case "python":
      args = ["--python_out=" + task.output_path];
    break;
    case "ruby":
      args = ["--ruby_out=" + task.output_path];
      break;
    default:
      args = ["--descriptor_set_out=" + task.output_path,
              "--include_source_info"];
  }
  args.push("-I" + task.input_path);
  var input_dirs = [task.input_path];
  async.whilst(function() {
    return input_dirs.length > 0;
  }, function(cb) {
    var dir = input_dirs.shift();
    // console.log("\tExamining " + dir);
    fs.readdir(dir, function(e, baseNames) {
      if (e) return cb(e);

      // console.log("Contents of " + dir + ": " + inspect(baseNames));
      async.eachLimit(baseNames, 4, function(baseName, cb) {

        var p = path.join(dir, baseName);

        fs.stat(p, function(e, stats) {
          if (e) return cb(e);
          // console.log("\tStated " + baseName);
          if (stats.isFile() && /\.proto$/.test(baseName)) {
            args.push(p);
          } else if (stats.isDirectory()) {
            input_dirs.push(p);
          }
          cb();
        });
      }, cb);
    });
  }, function(e) {
    if (e) return cb(e);

    child_process.execFile("protoc", args, {
      cwd: task.input_path,
      timeout: 5000 // 5 second timeout
    }, function(e, stdout, stderr) {
      task.stdout = stdout;
      task.stderr = stderr;
      task.args = args;

      // console.log("Done executing: " + inspect(task));
      // console.log(inspect(e));
      cb(e, task);
    });
  });
}, 2);
COMPILE_QUEUE.total_run = 0;
app.get('/queuez', function(req, res) {
  res.send([
    "{",
    '  "length": ' + COMPILE_QUEUE.length() + ',',
    '  "started": ' + COMPILE_QUEUE.started + ',',
    '  "running": ' + COMPILE_QUEUE.running() + ',',
    '  "idle": ' + COMPILE_QUEUE.idle() + ',',
    '  "total_run": ' + COMPILE_QUEUE.total_run + ',',
    "}"
  ].join("\n"));
});

app.post('/compile', function(req, res) {
  var output = req.body.output;
  var errorCallback = function(e) { res.json(500, { error: e.message }); };
  async.parallel({
    input_path: function(cb) {
      tmp.dir(function(e, path) { cb(e, path); });
    },
    output_path: function(cb) {
      tmp.file({ postfix: '.zip' }, function(e, path, fd) { cb(e, path); });
    },
  }, function(e, paths) {
    if (e) return errorCallback(e);

    cleanupTempFiles = function(cb) {
      async.parallel({
        input_path: function(cb) {
          // console.log("Removing input_path: " + paths.input_path);
          rimraf(paths.input_path, cb);
        },
        output_path: function(cb) {
          // console.log("Removing output_path: " + paths.output_path);
          rimraf(paths.output_path, cb);
        }
      }, cb);
    };
    errorCallback = function(e) {
      cleanupTempFiles(function() { res.json(500, { error: e.message }); });
    };
    var attemptCompileEnqueue = function attemptCompileEnqueue() {
      if (!attemptCompileEnqueue.formFinished || attemptCompileEnqueue.files > 0) return;

      COMPILE_QUEUE.push(paths, function(e, task) {
        if (e) {
          e.message = e.message || task.stderr;
          errorCallback(e);
          return;
        }
        res.sendfile(task.output_path, function() {
          cleanupTempFiles(function() {});
        });
      });
    };
    attemptCompileEnqueue.formFinished = false;
    attemptCompileEnqueue.files = 0;

    try {
      var busboy = new Busboy({ headers: req.headers });
      busboy.on('file', function(fieldname, file, filename, encoding, mimetype) {
        var input_zip_path = path.join(paths.input_path, "input.zip");
        if (fieldname == "input") {
          attemptCompileEnqueue.files += 1;
          file.pipe(fs.createWriteStream(input_zip_path)).on("close", function() {
            console.log("Close called");
            fs.createReadStream(input_zip_path).pipe(unzip.Extract({ path: paths.input_path }))
              .on("close", function() {
                attemptCompileEnqueue.files -= 1;
                attemptCompileEnqueue();
              });
          }).on("end", function() { console.log("end called"); });
        }
        // console.log('File [' + fieldname + ']: filename: ' + filename + ', encoding: ' + encoding);
      });
      busboy.on('field', function(fieldname, val, fieldnameTruncated, valTruncated) {
        if (fieldname == "output") paths.output = val;
        // console.log('Field [' + fieldname + ']: value: ' + inspect(val));
      });
      busboy.on('finish', function() {
        // console.log('Done parsing form!');
        attemptCompileEnqueue.formFinished = true;
        attemptCompileEnqueue();
      });
      req.pipe(busboy);
    } catch(err) {
      errorCallback(err);
    }
  });
});

var port = Number(process.env.PORT || 5000);
app.listen(port, function() {
  // console.log("Listening on " + port);
});
