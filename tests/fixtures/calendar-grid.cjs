// Synthetic image-recognition output; deliberately separate from real vision testing.
module.exports=function grid(year=2026,month=10,marks={'10':'A','11':'all','17':'B'},start=0){
 const n=new Date(Date.UTC(year,month,0)).getUTCDate(),offset=(new Date(Date.UTC(year,month-1,1)).getUTCDay()-start+7)%7;
 const cells=Array.from({length:Math.ceil((offset+n)/7)*7},(_,i)=>{const day=i-offset+1;return day<1||day>n?null:String(day)+(marks[day]?':'+marks[day]:'');});
 return {year,month,complete:true,weekdays:Array.from({length:7},(_,i)=>['日','月','火','水','木','金','土'][(start+i)%7]),rows:Array.from({length:cells.length/7},(_,i)=>cells.slice(i*7,i*7+7))};
};
