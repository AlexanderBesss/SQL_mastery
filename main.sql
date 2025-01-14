select title, rental_duration from film where  rental_duration != 5;

select  * from customer  where lower(first_name) = 'mary';
select  * from rental where rental_date >= '2006-01-01';
select  * from rental where rental_date = '2006-02-14 15:16:03';

select title, length, rental_duration from film where length > 100 and rental_duration = 5;
select title, length, rental_duration from film where ( length > 100 or rental_duration = 5) or left (title ,1) = 'A';
select title, length, rental_duration from film where not rental_duration = 5;

select * from customer where email  is not null ;
select  title, rating from film where rating  != 'PG' or rating is null;

select  customer_id from customer where customer_id not  between  1 and 5;
select  customer_id from customer where customer_id not in(1,5,8);
select  first_name from customer where left(first_name, 1) in ('A', 'F', 'J');

select  first_name from customer where first_name  like 'M%';
select  first_name from customer where first_name  like '__M%';
select  first_name from customer where first_name ilike '__m%';

select  first_name from customer where first_name similar to  'M%L{2}%';

select title, length from film order by length desc, title asc;
select title, length from film order by right(title, 1), length desc;

/* execution order in SQL:
1. from
2. where
3. group by: aggregate rows
4. having: filter the aggregates
5. select
6. order by
7. limit
*/

-- Pagination
select first_name, last_name from customer order by first_name limit 5;
select first_name, last_name from customer order by first_name limit 5 offset 10;
-- Non standard pagination
select first_name, last_name from customer order by first_name offset 10 fetch next 5 rows only;

--Remove duplicate rows (Unique combination of columns)
select distinct customer_id from payment;
select distinct date_part('month', payment_date) as month, date_part('year', payment_date) as year from payment order by year, month;

--if statement
select title, length,
	case
		when length <= 60 then 'short'
		when length > 60 and length <=120 then 'long'
		when length > 120 then 'very long'
		else 'unknown'
	end as length_description
from film;

-- Aggregate Functions
select count(*) from film;
select count(distinct rating) from film;
select sum(length) from film;
select min(amount), max(amount), avg(amount) from payment;

-- GROUP BY and HAVING(filter the result)
select rating, count(*) from film group by rating;

select customer_id, staff_id, count(*) from payment
group by customer_id, staff_id 
having count(*) > 20
order by customer_id , staff_id;
-- Group by fist latter of user name
select left(first_name, 1) as first_latter, count(*) from customer
group by left(first_name, 1)
order by first_latter;

-- GROUP BY with CASE (expression should be the same in the SELECT and the GROUP BY section)
select
    case 
    	when length < 60 then 'short'
    	when length between 60 and 120 then 'medium'
    	when length > 120 then 'long'
    	else 'short'
    end,
    count(*)
from film
group by
    case 
    	when length < 60 then 'short'
    	when length between 60 and 120 then 'medium'
    	when length > 120 then 'long'
    	else 'short'
    end;
-- Short version (1 - first position in the SELECT section)
select
    case 
    	when length < 60 then 'short'
    	when length between 60 and 120 then 'medium'
    	when length > 120 then 'long'
    	else 'short'
    end,
    count(*)
from film
group by 1;
-- CASE inside aggregation function
select sum(case when rating in ('R', 'NC-17') then 1 else 0 end) as adult_films, 
       count(*), 
       100.0 * sum(case when rating in ('R', 'NC-17') then 1 else 0 end) as adult_films, count(*) / count(*) as persentage
from film;
-- Postgres DB simplified version
select 
	count(*) filter(where rating in ('R', 'NC-17')) as adult_films,
	count(*) filter(where rating = 'G' and length > 120) as mixed 
from film;
-- The same result using WHERE for single element
select count(*) from film where rating in ('R', 'NC-17');

-- Types in SQL
-- Strings
select concat(first_name, ' has email ', email) from customer where email is null;
select first_name || ' has email ' || coalesce(email, 'unknown')from customer where email is null; 
select first_name || ' was created on ' || create_date from customer;
select length(trim('   1234    '));
select * from address where length(trim(address2)) > 0 and address2 is not null;
-- Numbers
select pg_typeof( 3/2 ); -- result: 1 integer
select pg_typeof( 3.0/2 ); -- result: 1.5 numeric
-- 3 different ways to case string into int4
select int '33', '33'::int, cast('33' as int);
-- Cast bigint into int as function parameter
select rating, repeat('*', (count(*) / 10)::int) as "count/10" from film where rating is not null group by rating;

-- numeric(precision, scale);
-- numeric(5,2) -- 999,99 total length is 5, 2 after the comma 
-- real   -- 6 digit after comma
-- double -- 15 digit after comma
select 0.4235::numeric(5,4) * 10000000,  0.4235::real * 10000000; -- 'real' introduce some errors, 'numeric' is recommended

-- Dates
select '2018-01-01'::date - '2017-01-01'::date; -- return difference in days: 365
select '2018-01-01 3:00 Australia/Brisbane'::timestamptz;
select '2018-01-01 3:00 +10'::timestamptz;
select '2018-01-01 3:00 EST'::timestamptz; -- returns time relative to local time zone
select timestamptz '2018-01-01 08:35 +8' - timestamptz '2018-01-01 08:35 EST';
select timestamptz '2018-01-01 08:35 +8' + interval '13 days 3 hours'; -- add time 
select customer_id, sum(return_date - rental_date) from rental group by customer_id;
select 
	customer_id,
	sum(return_date - rental_date),
	justify_hours(sum(return_date - rental_date))
from rental group by customer_id;
select date_part('year', timestamptz '2018-01-01 08:35 +8'); -- returns year part in date
select date_part('epoch', timestamptz '2018-02-01 08:35 +8' - timestamptz '2018-01-01 010:35 +8'); -- returns difference in seconds
select date_trunc('year', timestamptz '2018-03-01 08:35 +8'); -- 2018-01-01 00:00:00.000 +0200
select date_trunc('month', timestamptz '2018-03-01 08:35 +8'); -- 2018-03-01 00:00:00.000 +0200 // returns given part of the date and rest of it is zeroes. It useful in grouping by dates
select current_date, current_time, current_timestamp; -- functions to display current date

-- JOINS
-- CROSS JOIN
/* T1	T2 --> T1xT2 = 9, all possible combinations
   1	A
   2	B
   3	C */
select film_id, store_id from film cross join store order by film_id, store_id;
select customer_id, staff_id, customer.email, staff.email from customer cross join staff; -- in case if both tables have the same column
select c.customer_id, s.staff_id, c.email, s.email from customer as c cross join staff as s; -- with aliases in the tables

-- INNER JOIN - the same as cross join but with a filter
select rental_date, first_name, last_name from rental inner join customer on rental.customer_id  = customer.customer_id;
select * from film as f inner join film_actor as fa on f.film_id = fa.film_id where f.film_id = 803; -- no result for 803 id in case it does not exist in film_actor table
-- Join multiple tables, 1x1 relation. By default "join" will be use inner join
select c.first_name || ' ' || c.last_name, city.city, country.country 
	from customer as c 
		inner join address as addr 
			on c.address_id = addr.address_id
		inner join city 
			on addr.city_id = city.city_id
		join country 
			on country.country_id = city.country_id;
-- shorter version by: using(column_name). Column names should be the same on joining tables
select c.first_name || ' ' || c.last_name, city.city, country.country 
	from customer as c 
		inner join address using(address_id)
		inner join city using(city_id)
		join country using(country_id);

-- OUTER JOIN, the same as inner join but it will display missing rows. Possible way to display a result left join(everything from left table), right join(from right table), full join(from both tables)
-- LEFT OUTER JOIN. the "outer" word could be dropped
select f.film_id, f.title, fa.actor_id from film as f left outer join film_actor as fa on f.film_id = fa.film_id where f.film_id = 803; -- returns null result, (no result for inner join)
-- RIGHT JOIN is rare, if you want to use the RIGHT JOIN, you can flip the tables and use LEFT JOIN instead. It is easier to understand!

-- Number of actors
select f.film_id, f.title, count(fa.actor_id) as "number of actors" from film as f
	left outer join film_actor as fa 
		on f.film_id = fa.film_id
	group by f.film_id, f.title
	order by f.film_id;
-- Note: if combining outer join with inner join, we may lose null output
select f.film_id, f.title, fa.actor_id, a.first_name, a.last_name 
from film as f
	left join film_actor as fa 
		on f.film_id = fa.film_id
	inner join actor as a
		on fa.actor_id = a.actor_id
	order by f.film_id; -- 803 film is missing here!!!
-- To fix this: first execute inner join in brackets and the left join with film table
 select f.film_id, f.title, fa.actor_id, a.first_name, a.last_name 
 from film as f
	left join 
		(film_actor as fa
			inner join actor as a
				on fa.film_id = a.actor_id)
		on fa.actor_id = a.actor_id
	order by f.film_id;
-- FULL JOIN is rare

-- Concept of "SELF join"
select c1.first_name || ' ' || c1.last_name, c2.first_name || ' ' || c2.last_name from customer as c1
	cross join customer  as c2;
select c1.first_name || ' ' || c1.last_name, c2.first_name || ' ' || c2.last_name from customer as c1
	inner join customer  as c2 
		on c1.customer_id < c2.customer_id;

-- Concept of "COMPOSITE join"
select c1.first_name || ' ' || c1.last_name, c2.first_name || ' ' || c2.last_name from customer as c1
	inner join customer  as c2 
		on c1.customer_id < c2.customer_id
		and c1.customer_id <=3
		and c2.customer_id <=3;

-- SUB-QUERY. Un-CORRELATED sub query, it has no dependency to the main query
select title, length from film where length > (select avg(length) from film) order by length; -- sub query returns a single value to use it in "where".
-- Sub-query in select
select 
	customer_id,
	sum(amount) as customer_amount,
	100.0 * sum(amount) / (select sum(amount) from payment) as pct
from payment group by customer_id order by pct desc;

select title, rating from film where rating in ('PG', 'PG-13');
select title, rating from film where rating in (select distinct rating from film where left(cast(rating as text), 2) = 'PG'); -- the same result as above ^

select * from actor where actor_id  not in (select distinct actor_id from actor
											inner join film_actor using(actor_id)
											inner join film using(film_id)
											where rating = 'R');
-- CORRELATED SUBQUERY. Runs the query for each row. The same result could be done with JOINs!
select c.customer_id, c.first_name, c.last_name,
(select max(r.rental_date) from rental as r where r.customer_id = c.customer_id) as "most recent rental"
from customer as c;
-- Returns customers where total amount of payments are less the 100
select c.customer_id, c.first_name, c.last_name
from customer as c where (select sum(amount) from payment as p where p.customer_id = c.customer_id) < 100;
-- Return customers with at least 1 payment
select c.customer_id, c.first_name, c.last_name
from customer as c where exists (select * from payment as p where p.customer_id = c.customer_id);
-- Show previous rental_date for each customer. CORRELATED SUBQUERIES are useful for such queries
select 
	r1.rental_id, r1.customer_id, r1.rental_date,
	(select max(r2.rental_date) from rental as r2 where r2.customer_id = r1.customer_id and r2.rental_date < r1.rental_date)  as prev_rental_date
from rental as r1 order by r1.customer_id , r1.rental_date;

-- TABLE QUERIES. Creates a virtual table. Useful if you need multiple passes over some data. Also useful to resolve issue with repeating column due to SQL order execution.
-- Show the average number of rentals per customer
select avg(count) from (select customer_id, count(*) from rental group by customer_id) as t;
-- Create a virtual table with own data
select f.film_id, f.title, f.length, c.desc from film as f inner join 
			(values
				('short', 0 ,60),
				('medium', 60 ,120),
				('long', 120 ,10000)) as c("desc", "min", "max")
				on f.length  >= c.min and f.length < c.max;

-- LATERAL subqueries (Very useful!!!). It is CORRELATED table. It will be create a new table for each main row
-- return the 3 most recent rentals for each customer
select c.customer_id, d.rental_id, d.rental_date from customer as c inner join lateral
		(select r.customer_id, r.rental_id, r.rental_date from rental as r where r.customer_id = c.customer_id order by r.rental_date desc limit 3) as d
		on c.customer_id = d.customer_id;

-- Common table expressions - CTE (Increase readability of sub-queries)
 with film_stats as -- possible to rename column names: with film_stat(t,rr,rc,be) as
 (
 	select title, rental_rate, replacement_cost, ceil(replacement_cost / rental_rate) as break_even from film
 ),
 second_table as -- define multiple queries
 (
  -- possible to refer in this query to film_stats table
 )
 select * from film_stats where break_even > 30;

-- Ranking window functions (over window)
select 
	title,
	length,
	rating,
	row_number() over (order by length), -- returns row number base on length of the films. Like ranking system
	rank() over (order by length), -- almost the same as the first one, but the same fil  m length have the same rank (with counter behind)
	dense_rank() over (order by length), -- almost the same as the first one, but the same film length have the same rank
	row_number() over (partition by rating order by length) -- apply partition for rating column (divide groups into smaller groups, but those groups are start from the beginning)
from film;

-- Aggregate window functions
select 
	title, 
	rating, 
	length,
	avg(length) over(partition by rating) -- calculate value over of window of films: each group select avg(length) from film where rating = 'G';
from film;
select 
	customer_id,
	payment_date,
	amount,
	sum(amount) over(
		partition by customer_id 
		order by payment_date
		-- rows between unbounded preceding and current row -- default value if order by was used
		rows between 2 preceding and current row -- override the calculation
		-- rows between unbounded preceding and unbounded following  -- default without order by
	) 
from payment;
-- Lag and Lead functions
select 
	rental_id,
 	customer_id,
    rental_date,
	lag(rental_date) over(partition by customer_id order by rental_date),
	lead(rental_date) over(partition by customer_id order by rental_date)
from rental;

-- Set operations
-- UNION, Combine the result of two queries (It will remove duplicates)
-- UNION ALL (It will not remove duplicates)
select first_name, last_name from customer
UNION
select first_name, last_name from staff
UNION ALL
select first_name, last_name from actor
ORDER BY first_name;

-- INTERSECT, returns the common rows between two queries
select customer_id from customer where customer_id between 1 and 10
INTERSECT
select customer_id from customer where customer_id between 1 and 5;
-- EXCEPT, returns the rows that are in the first query but not in the second query (EXCEPT ALL will not remove duplicates)
select customer_id from customer where customer_id between 1 and 10
EXCEPT
select customer_id from customer where customer_id between 1 and 5;

-- TABLE/DATA MANIPULATION
-- Create tables if not exists
create table if not exists users(
	id serial primary key,
	first_name varchar(100) not null,
	last_name varchar(100) not null,
	email varchar(100) not null unique,
	date_of_birth date not null,
	created_at timestamptz default current_timestamp
);

-- insert data into the table
insert into users(first_name, last_name, email, date_of_birth) 
	values('John', 'Doe', 'alexandrbesss@gmail.com', '1992-03-13');
select * from users;

-- Add a new column to the table
alter table users add is_active boolean default true;
-- Rename column
alter table users rename column is_active to active;
-- Remove column
alter table users drop column active;
-- Drop table
drop table if exists users;

-- Working with Schema
create schema if not exists playground;
create table if not exists playground.users(
	email varchar(100) constraint pk_index_123 primary key, -- constraint pk_index_123 is name of the index
	first_name varchar(100) not null,
	last_name varchar(100) not null,
	is_active boolean not null default true
);
insert into playground.users(first_name, last_name, email, is_active) 
	values('John', 'Doe', 'alexandrbesss@gmail.com', false);
select * from playground.users;
drop table if exists playground.users;

create table if not exists playground.notes(
	note_id bigint generated by default as identity primary key, -- behaves like serial
	note text not null,
	email varchar(100) references playground.users(email) on delete cascade on update cascade -- foreign key with cascade
);
insert into playground.notes(note, email) values('Hello world', 'alexandrbesss@gmail.com');
select * from playground.notes;
drop table if exists playground.notes cascade; -- cascade will remove all dependencies

create table if not exists playground.note_tags(
	note_id bigint,
	tag varchar(100) not null,
	primary key(note_id, tag), -- composite primary key
	foreign key(note_id) references playground.notes(note_id) on delete cascade on update cascade -- foreign key with cascade
);
insert into playground.note_tags(note_id, tag) values(1, 'important');
select * from playground.note_tags;

-- Update cascade, all related tables with the email will be updated
update playground.users set email = 'test@test.com' where email = 'alexandrbesss@gmail.com';

-- Delete schema
drop schema if exists playground cascade;

-- Check constraints
create table if not exists playground.users(
	email varchar(100) check(length(email) > 3 and position('@' in email) > 0),
	tag varchar(100) check(tag in ('important', 'work', 'personal')),
	date_of_birth date not null,
	created_at timestamptz default now(),
	updated_at timestamptz default current_timestamp,
	check(date_of_birth < current_date),
	check(created_at < updated_at)
);

-- Import and export data
copy playground.users from 'C:\Users\Public\users.csv' with(format csv, header true);
copy playground.users to 'C:\Users\Public\users.csv' with(format csv, header true);

-- Transactions
begin;
insert into playground.users(email, first_name, last_name) values('test4@test.com', 'John', 'Doe');
insert into playground.users(email, first_name, last_name) values('test5@test.com', 'John', 'Doe') returning *;
select * from playground.users;
rollback; -- undo the changes
commit; -- save the changes

-- Update data
update playground.users set first_name = initcap('Jane'), last_name = initcap('abc') where email = 'test3@test.com';
select * from playground.users;

-- Update data with sub-query, data comes from another table
begin;
update payment
set payment_date = (
	select rental_date 
	from rental 
	where payment.rental_id = rental.rental_id
);
select r.rental_id, r.rental_date, p.payment_id, p.payment_date from rental as r inner join payment as p using(rental_id);
rollback;

-- Delete data
begin;
delete from playground.users where email = 'test3@test.com' returning *;
select * from playground.users;
rollback;

-- Delete all data from the table
begin;
delete from playground.users;
select * from playground.users;
rollback;

-- Delete data with sub-query where customer name is John
begin;
delete from payment where exists(
	select * from customer where first_name = 'JOHN' and customer.customer_id = payment.customer_id) returning *;
rollback;

-- Truncate table, it will remove all data from the table(very fast)
begin;
truncate table playground.users;
select * from playground.users;
rollback;
