require 'json'
$recs=File.foreach(ARGV[0]).map{|l| JSON.parse(l)}
puts "ready"; STDOUT.flush; sleep 600
