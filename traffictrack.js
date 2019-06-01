const mongoose = require('mongoose');
const cron = require('node-cron');
const args = require('minimist')(process.argv.slice(2));
const Schema = mongoose.Schema;
const OnWater = require('onwater');
const distance = require('google-distance-matrix');
const geocoder = require('geocoder');
const dotenv = require('dotenv');
const async = require('async');



dotenv.config();

const googleAPIKey = process.env.MAPS_API_KEY;

mongoose.set('useFindAndModify', false);
distance.key(googleAPIKey);
distance.traffic_model('best_guess');
distance.mode('driving');
distance.units('metric');




const onWaterKey = process.env.ONWATER_API_KEY;
const onWater = new OnWater(onWaterKey);

const helpDoc = `
Usage:
traffictrack.js -t run
traffictrack.js -t add [--name=Dublin] [--lat=53.343] [--lng=-6.264]
traffictrack.js -h | --help
`;

// defining location schema & model
const LocationSchema = new Schema({
  name: String,
  lat: Number,
  lng: Number,
  country: String,
  points: [
    {
      name: String,
      lat: Number,
      lng: Number,
      onLand: Boolean
    }
  ],
  trafficData: [
    {
      time: Date,
      trips: Number,
      averageTime: Number,
      averageDistance: Number,
      totalTime: Number,
      totalDistance: Number,
      minTime: {
        value: Number,
        distance: Number,
        from: String,
        to: String
      },
      maxTime: {
        value: Number,
        distance: Number,
        from: String,
        to: String
      },
      minDistance: {
        value: Number,
        time: Number,
        from: String,
        to: String
      },
      maxDistance: {
        value: Number,
        time: Number,
        from: String,
        to: String
      },
      raw: Schema.Types.Mixed
    }
  ]

});

const Location = mongoose.model('Location', LocationSchema, 'locations');

const LatLng = function (lat, lng) {
  this.lat = lat;
  this.lng = lng;
}

// changes time string to HH:MM:SS format
String.prototype.toHHMMSS = function () {
  let sec_num = parseInt(this, 10); // don't forget the second param
  let hours   = Math.floor(sec_num / 3600);
  let minutes = Math.floor((sec_num - (hours * 3600)) / 60);
  let seconds = sec_num - (hours * 3600) - (minutes * 60);

  if (hours   < 10) {hours   = "0"+hours;}
  if (minutes < 10) {minutes = "0"+minutes;}
  if (seconds < 10) {seconds = "0"+seconds;}
  return hours+':'+minutes+':'+seconds;
}

// changes degrees to radians
Number.prototype.toRad = function() {
  return this * Math.PI / 180;
}

// changes radians to degrees
Number.prototype.toDeg = function() {
  return this * 180 / Math.PI;
}

// valid arguments to pass with -t
const validArgs = ['add', 'run', 'update', 'get', 'refresh'];

// radius used when getting points for location
const radiusInKm = 10;


// function to get a lat lng point at a given bearing (0 - 360) and distance (Km) from the origin
function getDestinationPoint(origin, brng, dist) {
  dist = dist / 6371;
  brng = brng.toRad();

  let lat1 = origin.lat.toRad(), lon1 = origin.lng.toRad();

  let lat2 = Math.asin(Math.sin(lat1) * Math.cos(dist) +
                       Math.cos(lat1) * Math.sin(dist) * Math.cos(brng));

  let lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(dist) *
                               Math.cos(lat1),
                               Math.cos(dist) - Math.sin(lat1) *
                               Math.sin(lat2));

  if (isNaN(lat2) || isNaN(lon2)) return null;

  return new LatLng(lat2.toDeg(), lon2.toDeg());
}

// displays helpDoc and quits program
function logArgHelp() {
  console.log(helpDoc);
  process.exit();
}

// connects to DB and calls function depending on passed -t arg
function connectToDB() {
  mongoose.connect(process.env.DB_URL, { useNewUrlParser: true })
  .then(() => {
    console.log('Connected to database');
    switch (args.t) {
      case 'add':
        addLocation();
        break;
      case 'update':
        updatePoints();
        break;
      case 'get':
        if (args.name)
          getDistances(args.name);
          // getGdistance(args.name);
        else getAllDistances();
        break;
      case 'run':
        runCron();
        break;
      case 'refresh':
        removeTrafficData();
        break;
    }
  })
  .catch(() => {
    console.log('Error connecting to database');
  });
}

// adds a new location to DB using -t add --name=<name> --lat=<lat> --lng=<lng>
function addLocation() {
  if (args.name && args.lat && args.lng) {
    Location.find({ name: args.name }, function (err, docs) { // checking for duplicates
      if (docs.length > 0) {
        console.log('Location already exists!')
        process.exit();
      } else {
        const location = new Location({
          name: args.name,
          lat: args.lat,
          lng: args.lng
        });
        location.save(function (err, location) {
          if (err) return console.error(err);
          console.log(location.name + " saved to locations collection");
          updatePoints();
        });
      }
    });

  } else logArgHelp();
}

// checks points array for each location and adds cardinal & ordinal points, then calls function to check if points are on land
function updatePoints() {
  Location.find({}, function (err, locs) {
    locs.forEach(loc => {
      if (loc.points.length < 9) {
        loc.points = [];
        loc.points.push({ name: 'CENTER', lat: loc.lat.toFixed(3), lng: loc.lng.toFixed(3) });

        const pointNames = ['N','NE','E','SE','S','SW','W','NW'];
        let nameCount = 0;
        const centerPoint = new LatLng(loc.lat, loc.lng);
        for (let a = 0; a < 360; a += 45){
          const point = getDestinationPoint(centerPoint, a, radiusInKm);
          loc.points.push({ name: pointNames[nameCount], lat: point.lat.toFixed(3), lng: point.lng.toFixed(3) });
          nameCount ++;
        }
        Location.findByIdAndUpdate(loc._id, { points: loc.points }, function (err, doc) {
          console.log('Added points for ' + doc.name);
        });
      }
      loc.points.forEach(point => {
        if (point.onLand === undefined) {
          waterCheck(point, loc);
        }
      });
    });
    updateCountries();
  });
}


// uses google's reverse geocode to find country for each location if it doesn't already exists on the document
function updateCountries() {
  Location.find({}, function (err, locs) {
    locs.forEach(loc => {
      if (!loc.country || loc.country === '') {
        geocoder.reverseGeocode( loc.lat, loc.lng, function ( err, data ) {
          data.results[0].address_components.forEach(addCmp => {
            if (addCmp.types.includes('country')) {
              Location.findByIdAndUpdate(loc._id, { country: addCmp.long_name }, function (err, doc) {
                console.log('Added country for ' + doc.name + ': ' + addCmp.long_name);
              });
            }
          });
        }, {key: googleAPIKey});
      }
    });
  });
}

// checks if a point is on water or land using onWater API, and saves value to the onLand property of the point
async function waterCheck(point, loc) {
  let response = await onWater.results(point.lat, point.lng);
  if (response.error) {
  } else {
    Location.updateOne({ 'points._id': point._id }, {
      '$set': {
      'points.$.onLand': !response.water
    }} , function (err) {
        if (err) console.log(err);
        else {
          console.log('Updated onLand for ' + point.name + ' point in ' + loc.name + ': ' + !response.water);
        }
    });
  }
}

// gets google maps distance matrix for all points of a given location, supplied by -t get --name=<name>, and calls function to log results to console
function getDistances(location) {
  Location.findOne({ name: location }, function (err, loc) {
    if (err) {
      console.log(err);
      process.exit();
    } else {
      const unixNow = Math.round(new Date(Date.now()) / 1000);
      distance.departure_time(unixNow);
      // console.log(unixNow);
      let points = [];
      loc.points.forEach(point => {
        if (point.onLand) {
          let pointString = point.lat.toString() + ',' + point.lng.toString();
          points.push(pointString);
        }
      });
      distance.matrix(points, points, function (err, distances) {
        if (!err) {
          logDistances(distances);
        } else console.log(err);
      })
    }
  });
}

// formats and logs results of distance matrix to console
function logDistances(distances) {
  // console.log(distances.rows[0].elements[1]);
  let validCount = 0, totalTime = 0, totalDistance = 0;
  let minDistance = {
    value: 0,
    time: 0,
    from: '',
    to: ''
  };
  let maxDistance = {
    value: 0,
    time: 0,
    from: '',
    to: ''
  };
  let minTime= {
    value: 0,
    distance: 0,
    from: '',
    to: ''
  };
  let maxTime = {
    value: 0,
    distance: 0,
    from: '',
    to: ''
  };
  for(let origin in distances.origin_addresses){
    for(let destination in distances.destination_addresses){
      if(distances.rows[origin].elements[destination].status === 'OK'){
        let distance = distances.rows[origin].elements[destination].distance.value;
        if (distance > 0) {
          let time = distances.rows[origin].elements[destination].duration_in_traffic.value;
          if(distance > maxDistance.value){
            maxDistance.value = distance;
            maxDistance.time = time;
            maxDistance.from = distances.origin_addresses[origin];
            maxDistance.to = distances.destination_addresses[destination];
          } else if(minDistance.value === 0 || distance < minDistance.value){
            minDistance.value = distance;
            minDistance.time = time;
            minDistance.from = distances.origin_addresses[origin];
            minDistance.to = distances.destination_addresses[destination];
          }
          if(time > maxTime.value){
            maxTime.value = time;
            maxTime.distance = distance;
            maxTime.from = distances.origin_addresses[origin];
            maxTime.to = distances.destination_addresses[destination];
          } else if(minTime.value === 0 || time < minTime.value){
            minTime.value = time;
            minTime.distance = distance;
            minTime.from = distances.origin_addresses[origin];
            minTime.to = distances.destination_addresses[destination];
          }
          validCount ++;
          totalTime += time;
          totalDistance += distance;
        }
      }
    }
  }

  let averageTime = (totalTime / validCount);
  let averageDistance = (totalDistance / validCount);
  console.log('\n------------------------------------------------------');
  console.log('\nAverage trip time is ' + averageTime.toString().toHHMMSS() + ' based on ' + validCount + ' trips');
  console.log('\nAverage distance is ' + (averageDistance / 1000).toFixed(2) + ' Km based on ' + validCount + ' trips');
  console.log('\nTotal Time is ' + totalTime.toString().toHHMMSS());
  console.log('\nTotal distance is ' + (totalDistance / 1000).toFixed(2) + ' Km');
  console.log('\n------------------------------------------------------');
  console.log('\nMIN TRIP DISTANCE: ' + minDistance.value / 1000 + ' Km (' + minDistance.time.toString().toHHMMSS() + ')');
  console.log(minDistance.from);
  console.log('to');
  console.log(minDistance.to);
  console.log('\n------------------------------------------------------');
  console.log('\nMAX TRIP DISTANCE: ' + maxDistance.value / 1000 + ' Km (' + maxDistance.time.toString().toHHMMSS() + ')');
  console.log(maxDistance.from);
  console.log('to');
  console.log(maxDistance.to);
  console.log('\n------------------------------------------------------');
  console.log('\nMIN TRIP TIME: ' + minTime.value.toString().toHHMMSS() + ' (' + minTime.distance / 1000 + ' Km)');
  console.log(minTime.from);
  console.log('to');
  console.log(minTime.to);
  console.log('\n------------------------------------------------------');
  console.log('\nMAX TRIP TIME: ' + maxTime.value.toString().toHHMMSS() + ' (' + maxTime.distance / 1000 + ' Km)');
  console.log(maxTime.from);
  console.log('to');
  console.log(maxTime.to);
  console.log('\n------------------------------------------------------');
}

// gets distance matrix for each location in DB and saves to documents
function getAllDistances() {

  Location.find({}, function (err, locs) {
    if (err) {
      console.log(err);
      process.exit();
    } else {
      const unixNow = Math.round(new Date(Date.now()) / 1000);
      distance.departure_time(unixNow);
      async.each(locs, function (loc, callback) {
        let points = [];
        loc.points.forEach(point => {
          if (point.onLand) {
            let pointString = point.lat.toString() + ',' + point.lng.toString();
            points.push(pointString);
          }
        });
        getDistanceMatrix(loc, points, function () {
          //async call is done, alert via cb
          callback();
        });
      },
        function (err) {
          console.log('all done');
          // mongoose.disconnect();
        }
      );
    }
  });
}

async function getDistanceMatrix(loc, points, callback) {
  distance.matrix(points, points, function (err, distances) {
    if (!err) {
      loc.latestDistances = distances;
      saveDistances(loc, function () {
        callback();
      });
    } else console.log(err);
  });
}

// formats and saves distance matrix to location in DB
async function saveDistances(loc, callback) {
  let validCount = 0, totalTime = 0, totalDistance = 0;
  let minDistance = {
    value: 0,
    time: 0,
    from: '',
    to: ''
  };
  let maxDistance = {
    value: 0,
    time: 0,
    from: '',
    to: ''
  };
  let minTime = {
    value: 0,
    distance: 0,
    from: '',
    to: ''
  };
  let maxTime = {
    value: 0,
    distance: 0,
    from: '',
    to: ''
  };
  for (let origin in loc.latestDistances.origin_addresses) {
    for (let destination in loc.latestDistances.destination_addresses) {
      if (loc.latestDistances.rows[origin].elements[destination].status === 'OK') {
        let distance = loc.latestDistances.rows[origin].elements[destination].distance.value;
        if (distance > 0) {
          let time = loc.latestDistances.rows[origin].elements[destination].duration_in_traffic.value;
          if (distance > maxDistance.value) {
            maxDistance.value = distance;
            maxDistance.time = time;
            maxDistance.from = loc.latestDistances.origin_addresses[origin];
            maxDistance.to = loc.latestDistances.destination_addresses[destination];
          } else if (minDistance.value === 0 || distance < minDistance.value) {
            minDistance.value = distance;
            minDistance.time = time;
            minDistance.from = loc.latestDistances.origin_addresses[origin];
            minDistance.to = loc.latestDistances.destination_addresses[destination];
          }
          if (time > maxTime.value) {
            maxTime.value = time;
            maxTime.distance = distance;
            maxTime.from = loc.latestDistances.origin_addresses[origin];
            maxTime.to = loc.latestDistances.destination_addresses[destination];
          } else if (minTime.value === 0 || time < minTime.value) {
            minTime.value = time;
            minTime.distance = distance;
            minTime.from = loc.latestDistances.origin_addresses[origin];
            minTime.to = loc.latestDistances.destination_addresses[destination];
          }
          validCount++;
          totalTime += time;
          totalDistance += distance;
        }
      }
    }
  }

  let averageTime = (totalTime / validCount).toFixed(2);
  let averageDistance = (totalDistance / validCount).toFixed(2);

  let latestReading = {
    time: new Date(Date.now()),
    trips: validCount,
    averageTime: averageTime,
    averageDistance: averageDistance,
    totalTime: totalTime,
    totalDistance: totalDistance,
    minTime: minTime,
    maxTime: maxTime,
    minDistance: minDistance,
    maxDistance: maxDistance,
    raw: loc.latestDistances
  }

  Location.findByIdAndUpdate(loc._id, {
    '$push': {
      'trafficData': latestReading
    }
  }, function (err, doc) {
      if (err) {
        console.log(err);
        callback();
      } else {
        console.log('Added latest reading for ' + loc.name);
        callback();
      }

    });


}

// runs crontab to call getAllDistances every hour
function runCron() {
  console.log('Starting crontab...');
  cron.schedule('0 * * * *', () => {
    console.log(new Date(Date.now()));
    getAllDistances();
  });
}

// removes trafficData from all locations in DB, called by -t refresh
function removeTrafficData() {
  Location.updateMany({}, { trafficData: [] }, { multi: true }, function (err, res) {
    if (err) console.log(err);
    else console.log('removed all traffic data');
    process.exit();
  });
}

// arg checking when program is run
if (args.t) {
  if (validArgs.includes(args.t)) {
    connectToDB();
  } else logArgHelp();

} else logArgHelp();